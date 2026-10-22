import { fileURLToPath } from "node:url";
import express from "express";
import authRouter from "../auth/authcontroller.ts";
import { assertAuthConfig } from "../auth/config.ts";
import { createDevLoginRouter } from "../auth/devlogin.ts";
import trainRouter from "../trains/traincontroller.ts";

assertAuthConfig();

const app = express();

app.use(express.json());
app.use(express.static(fileURLToPath(new URL("../../public", import.meta.url)), { extensions: ["html"] }));
app.use(createDevLoginRouter());
app.use(authRouter);
app.use(trainRouter);

export default app;
