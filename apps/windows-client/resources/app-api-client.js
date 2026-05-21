(function () {
  async function parseJsonResponse(response, route) {
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || `${route} returned ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function getJson(route) {
    const response = await fetch(route);
    return parseJsonResponse(response, route);
  }

  async function postJson(route, body) {
    const headers = { "content-type": "application/json" };
    if (body?.idempotencyKey) {
      headers["idempotency-key"] = body.idempotencyKey;
    }
    const response = await fetch(route, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return parseJsonResponse(response, route);
  }

  window.KimiCoworkApi = Object.freeze({
    getJson,
    postJson,
  });
}());
