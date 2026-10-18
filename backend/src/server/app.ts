import { fileURLToPath } from "node:url";
import express from "express";
import authRouter from "../auth/authcontroller.ts";
import trainRouter from "../trains/traincontroller.ts";

const app = express();

app.use(express.json());
app.use(express.static(fileURLToPath(new URL("../../public", import.meta.url)), { extensions: ["html"] }));
app.use(authRouter);
app.use(trainRouter);

export default app;
