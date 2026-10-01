export const API_PORT = Number(process.env.E2E_API_PORT ?? 3002);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5176);
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://central:central@localhost:5432/central_partner_e2e';
export const API_URL = `http://localhost:${API_PORT}/api/v1`;
