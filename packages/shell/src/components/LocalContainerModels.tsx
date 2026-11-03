import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";

/** Only lists installed models. This UI never calls the model-management API. */
export function LocalContainerModels({ model, onSelect }: { model: string; onSelect: (id: string) => void }) {
    const [models, setModels] = useState<string[]>([]);
    const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
    const [revision, retry] = useState(0);
    const selectRef = useRef(onSelect);
    selectRef.current = onSelect;
    useEffect(() => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        let live = true;
        setState("loading");
        Logger.debug("LocalContainerModels", "list installed models", { revision });
        void (async () => {
            try {
                const response = await fetch("/local-llm/v1/models", { signal: controller.signal });
                if (!response.ok) throw new Error("models unavailable");
                const json = await response.json();
                if (json.data !== null && !Array.isArray(json.data)) throw new Error("invalid models");
                const ids: string[] = [...new Set<string>((json.data ?? []).map((m: { id?: unknown }) => m?.id).filter((id: unknown): id is string => typeof id === "string" && id.length > 0))];
                if (!live) return;
                if (model && !ids.includes(model)) selectRef.current("");
                setModels(ids);
                setState(ids.length ? "ready" : "empty");
            } catch {
                if (live) { setModels([]); setState("error"); }
            } finally { clearTimeout(timeout); }
        })();
        return () => { live = false; clearTimeout(timeout); controller.abort(); };
    }, [revision]);
    const available = models.includes(model);
    return <div data-testid="local-container-models" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <p role={state === "error" ? "alert" : "status"}>{t(`localContainer.${state}`)}</p>
        {state === "ready" && <select id="model-select" value={available ? model : ""} aria-label={t("localContainer.choose")} onChange={e => selectRef.current(e.target.value)}>
            <option value="" disabled>{t("localContainer.choose")}</option>
            {models.map(id => <option key={id} value={id}>{id}</option>)}
        </select>}
        <p data-testid="local-container-limits">{t("localContainer.limits")}</p>
        {state === "empty" && <p>{t("localContainer.prepare")}</p>}
        {state === "error" && <p>{t("localContainer.recover")}</p>}
        <button className="btn-secondary" type="button" disabled={state === "loading"} onClick={() => retry(n => n + 1)}>{t("localContainer.retry")}</button>
    </div>;
}
