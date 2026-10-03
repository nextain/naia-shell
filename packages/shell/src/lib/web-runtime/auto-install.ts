import { installWebRuntime } from "./install";

if (import.meta.env.MODE === "web") installWebRuntime();
