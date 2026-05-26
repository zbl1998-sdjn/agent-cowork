import { useCallback, useRef, useState } from 'react';

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

type SpeechRecognitionWindow = {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

export function collectSpeechTranscript(results: ArrayLike<ArrayLike<{ transcript: string }>>) {
  let transcript = '';
  for (let i = 0; i < results.length; i += 1) {
    transcript += results[i][0].transcript;
  }
  return transcript;
}

export function useComposerVoice({
  onTranscript,
  onUnsupported,
}: {
  onTranscript: (transcript: string) => void;
  onUnsupported: () => void;
}) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);

  const resetRecognition = useCallback(() => {
    setListening(false);
    recognitionRef.current = null;
  }, []);

  const toggleVoice = useCallback(() => {
    const w = typeof window === 'undefined' ? undefined : (window as unknown as SpeechRecognitionWindow);
    const Ctor = w?.SpeechRecognition || w?.webkitSpeechRecognition;
    if (!Ctor) {
      onUnsupported();
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new Ctor();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => onTranscript(collectSpeechTranscript(event.results));
    recognition.onend = resetRecognition;
    recognition.onerror = resetRecognition;
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [listening, onTranscript, onUnsupported, resetRecognition]);

  return { listening, toggleVoice };
}
