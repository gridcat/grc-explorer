import http from 'http';

// SSR API calls go through axios, which uses Node's http.globalAgent;
// Node 22's default is keep-alive with maxSockets Infinity, so a burst
// of page renders opens one API connection per in-flight call (76 were
// observed under crawler load) and the API's small DB pool queues behind
// them. Capping the agent bounds concurrency toward the API: renders
// beyond the cap wait in-process for a free socket, still under the
// axios timeout, instead of piling onto the backend.
const API_MAX_SOCKETS = 32;

http.globalAgent.maxSockets = API_MAX_SOCKETS;
