import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Gives component tests a browser-like DOM (document, events, etc.).
GlobalRegistrator.register();

// Unit tests never touch a database; Bun would otherwise load DATABASE_URL from .env.
process.env["USER_STORE"] = "memory";
delete process.env["DATABASE_URL"];
