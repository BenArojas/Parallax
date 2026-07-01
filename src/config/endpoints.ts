/**
 * Centralized transport configuration.
 *
 * Every HTTP and WebSocket URL in the app derives from these two constants.
 * In dev mode the sidecar runs on localhost:8000. In production Tauri
 * launches the sidecar and the same URL applies.
 *
 * If the port or host ever needs to change (e.g., Orbit consolidation,
 * dynamic port assignment), this is the only file to touch.
 */

const SIDECAR_HOST = "localhost";
const SIDECAR_PORT = 8000;

/** HTTP base URL for the Python FastAPI sidecar */
export const API_BASE = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;

/** WebSocket URL for live market data streaming */
export const WS_URL = `ws://${SIDECAR_HOST}:${SIDECAR_PORT}/ws`;

/** WebSocket URL for TWS Execution Assistant market-data control/status streaming */
export const TWS_STREAM_URL = `ws://${SIDECAR_HOST}:${SIDECAR_PORT}/execution-assistant/ws`;

/**
 * IBKR Client Portal Gateway base URL.
 * Port 5001 is the default — matches backend/config.py IBKR_GATEWAY_PORT.
 * Port 5000 is intentionally avoided: it collides with macOS AirPlay Receiver.
 */
export const IBKR_GATEWAY_BASE_URL = "https://localhost:5001";
