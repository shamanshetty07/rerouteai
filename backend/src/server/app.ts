import express from "express";
import authRouter from "../auth/authcontroller.ts";

const app = express();

app.use(express.json());
app.use(authRouter);

export default app;
