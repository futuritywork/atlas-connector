import { parseEsbConfig } from "./schemas";

// ESB Core credentials arrive on each request and are never environment configuration.
export const CONFIG = parseEsbConfig(process.env);
