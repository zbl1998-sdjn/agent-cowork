//! Sidecar 身份探测辅助：challenge 编码、HMAC proof 校验与固定 loopback HTTP 探测。
//! 本模块不持有进程或 Tauri 状态；生命周期仍由 sidecar 模块单独负责。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use ring::hmac;

use crate::config::{HOST, PORT};

const SIDECAR_CHALLENGE_HEADER: &str = "x-acw-sidecar-challenge";
const SIDECAR_PROOF_HEADER: &str = "x-acw-sidecar-proof";
const SIDECAR_PROOF_CONTEXT: &str = "agent-cowork-sidecar-health-v1:";
pub(crate) const SECRET_BYTES: usize = 32;
const MAX_HEALTH_RESPONSE_BYTES: u64 = 16 * 1024;

pub(crate) fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_hex_32(value: &str) -> Option<[u8; SECRET_BYTES]> {
    if value.len() != SECRET_BYTES * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut output = [0_u8; SECRET_BYTES];
    for (index, slot) in output.iter_mut().enumerate() {
        let offset = index * 2;
        *slot = u8::from_str_radix(&value[offset..offset + 2], 16).ok()?;
    }
    Some(output)
}

fn verify_proof(secret: &[u8], challenge_hex: &str, proof_hex: &str) -> bool {
    let Some(proof) = decode_hex_32(proof_hex) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    let message = format!("{SIDECAR_PROOF_CONTEXT}{challenge_hex}");
    hmac::verify(&key, message.as_bytes(), &proof).is_ok()
}

/// 一次身份探测的结果:reachable 表示端口接受了连接(sidecar 至少活着),
/// verified 表示同时返回了合法 HMAC proof。监控循环用 reachable 区分"慢启动"与"真死"。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct HealthProbe {
    pub reachable: bool,
    pub verified: bool,
}

impl HealthProbe {
    const UNREACHABLE: Self = Self {
        reachable: false,
        verified: false,
    };
    const fn reachable(verified: bool) -> Self {
        Self {
            reachable: true,
            verified,
        }
    }
}

/// 对固定 loopback 端口发起一次带随机 challenge 的身份探测。
pub(crate) fn request_authenticated_health(
    address: &SocketAddr,
    secret: &[u8],
    challenge: &[u8; SECRET_BYTES],
) -> HealthProbe {
    let challenge_hex = encode_hex(challenge);
    let Ok(mut stream) = TcpStream::connect_timeout(address, Duration::from_millis(300)) else {
        return HealthProbe::UNREACHABLE;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

    let request = format!(
        "GET /health HTTP/1.1\r\nHost: {HOST}:{PORT}\r\n{SIDECAR_CHALLENGE_HEADER}: {challenge_hex}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return HealthProbe::reachable(false);
    }

    let mut response = Vec::new();
    if stream
        .take(MAX_HEALTH_RESPONSE_BYTES)
        .read_to_end(&mut response)
        .is_err()
    {
        return HealthProbe::reachable(false);
    }
    let Ok(response) = std::str::from_utf8(&response) else {
        return HealthProbe::reachable(false);
    };
    let Some((headers, _body)) = response.split_once("\r\n\r\n") else {
        return HealthProbe::reachable(false);
    };
    let mut lines = headers.split("\r\n");
    let status = lines.next().unwrap_or_default();
    if status != "HTTP/1.1 200 OK" && status != "HTTP/1.0 200 OK" {
        return HealthProbe::reachable(false);
    }

    let mut proof: Option<&str> = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return HealthProbe::reachable(false);
        };
        if name.eq_ignore_ascii_case(SIDECAR_PROOF_HEADER) {
            if proof.is_some() {
                return HealthProbe::reachable(false);
            }
            proof = Some(value.trim());
        }
    }
    HealthProbe::reachable(proof.is_some_and(|value| verify_proof(secret, &challenge_hex, value)))
}

#[cfg(test)]
mod tests {
    use super::{verify_proof, HealthProbe};

    const ZERO_SECRET: [u8; 32] = [0_u8; 32];
    const CHALLENGE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const VALID_PROOF: &str = "520d4536568f6fd6b8d6841c9d991bdefe9432d0e3e70ee4922b192ccb50874b";

    #[test]
    fn accepts_cross_language_hmac_vector() {
        assert!(verify_proof(&ZERO_SECRET, CHALLENGE, VALID_PROOF));
    }

    #[test]
    fn rejects_missing_or_wrong_proof() {
        assert!(!verify_proof(&ZERO_SECRET, CHALLENGE, ""));
        assert!(!verify_proof(
            &ZERO_SECRET,
            CHALLENGE,
            "0000000000000000000000000000000000000000000000000000000000000000"
        ));
    }

    #[test]
    fn health_probe_separates_reachable_from_verified() {
        // 端口没连上:两者都 false —— 监控循环据此判定"可能真死"。
        assert_eq!(
            HealthProbe::UNREACHABLE,
            HealthProbe {
                reachable: false,
                verified: false
            }
        );
        // 连上但还没给出合法 proof(慢启动/初始化中):reachable=true 但 verified=false,
        // 监控循环应继续重试而不是把健康的 sidecar 杀掉。
        assert_eq!(
            HealthProbe::reachable(false),
            HealthProbe {
                reachable: true,
                verified: false
            }
        );
        assert!(HealthProbe::reachable(true).verified);
    }
}
