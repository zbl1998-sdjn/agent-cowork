const { createInitialState, placeholders } = window.AgentCoworkAppState;
const state = createInitialState();
window.agentCowork = state;
const elements = window.AgentCoworkAppDom.collectAppDom();
const services = window.AgentCoworkShellServices.createShellServices({
    state,
    elements,
    placeholders,
    utils: window.AgentCoworkUtils,
    api: window.AgentCoworkApi,
});
window.AgentCoworkControllerAssembly.startApp({
    state,
    elements,
    services,
    utils: window.AgentCoworkUtils,
    api: window.AgentCoworkApi,
    runEvents: window.AgentCoworkRunEvents,
});
