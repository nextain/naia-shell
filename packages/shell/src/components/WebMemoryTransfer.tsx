import { isChatTransferBusy, useChatStore } from "../stores/chat";
import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import { resolveWebConversationsDir } from "../lib/web-runtime/web-workspace-commands";
import type { TransferManifest } from "../lib/transfer/manifest";

export function WebMemoryTransfer() {
    const [state, setState] = useState<"idle" | "working" | "wait" | "preview" | "error" | "exported" | "restored">("idle");
    const [preview, setPreview] = useState<TransferManifest>();
    const [file, setFile] = useState<File>();
    const dialog = useRef<HTMLDialogElement>(null);
    const busy = state === "working";
    const chatBusy = useChatStore(s => s.isStreaming || s.pendingApproval !== null || s.messageQueue.length > 0);
    const available = () => !isChatTransferBusy();
    useEffect(() => { if (state === "wait" && !chatBusy) setState(file && preview ? "preview" : "idle"); }, [state, chatBusy, file, preview]);
    const inspect = async (selected?: File) => {
        if (!selected || busy) return;
        if (!available()) { setState("wait"); return; }
        setState("working"); setPreview(undefined); setFile(undefined);
        Logger.debug("WebMemoryTransfer", "inspect", { bytes: selected.size });
        try {
            const { inspectWebTransfer } = await import("../lib/transfer/restore-web");
            const result = await inspectWebTransfer(selected);
            setFile(selected); setPreview(result.manifest); setState("preview");
            dialog.current?.showModal();
        } catch { setState("error"); }
    };
    const message = chatBusy && !busy && state !== "restored" ? t("browserMemory.wait") : (state === "idle" || state === "preview") ? "" : t(`browserMemory.${state}`);
    return <section className="settings-field browser-memory" data-testid="web-memory-transfer" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <h3>{t("browserMemory.title")}</h3>
        <p>{t("browserMemory.retention")}</p><p>{t("browserMemory.serverInfo")}</p><p>{t("browserMemory.contents")}</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="btn-secondary" data-testid="memory-transfer-export" disabled={busy || chatBusy} onClick={async () => {
                if (!available()) { setState("wait"); return; }
                setState("working");
                try {
                    const { downloadWebTransfer, loadTransfer } = await import("../lib/transfer/entry");
                    await downloadWebTransfer(await loadTransfer(), resolveWebConversationsDir()); setState("exported");
                } catch { setState("error"); }
            }}>{t("settings.memoryTransferExport")}</button>
            <label>{t("browserMemory.import")}<input type="file" accept=".zip,application/zip" data-testid="memory-transfer-import" disabled={busy || chatBusy} onChange={e => { const next = e.target.files?.[0]; e.target.value = ""; void inspect(next); }} /></label>
        </div>
        <p role={state === "error" ? "alert" : "status"}>{message}</p>
        <dialog className="browser-memory-dialog" ref={dialog} aria-labelledby="memory-preview-title" onCancel={e => { if (busy || state === "restored") e.preventDefault(); }} style={{ maxWidth: "min(600px, calc(100vw - 32px))", boxSizing: "border-box", overflowWrap: "anywhere" }}>
            <h3 id="memory-preview-title">{t("browserMemory.preview")}</h3>
            {preview && <><p>{t("browserMemory.files")}: {preview.fileCount} · {preview.totalBytes} B</p><p>{t("browserMemory.facts")}: {preview.memoryFacts ?? t("browserMemory.absent")}</p>
                <details><summary>{t("browserMemory.files")}</summary><ul style={{ maxHeight: "25vh", overflow: "auto" }}>{preview.files.map(item => <li key={item.path}>{item.path}</li>)}</ul></details></>}
            <p>{t("browserMemory.overwrite")}</p>
            <p role={state === "error" ? "alert" : "status"}>{message}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {state === "restored" ? <button type="button" onClick={() => location.reload()}>{t("browserMemory.reload")}</button> : <>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => { dialog.current?.close(); setPreview(undefined); setFile(undefined); setState("idle"); }}>{t("browserMemory.cancel")}</button>
                <button type="button" disabled={busy || !file || chatBusy} data-testid="memory-transfer-restore" onClick={async () => {
                    if (!file || busy) return;
                    if (!available()) { setState("wait"); return; }
                    setState("working");
                    try { const { restoreWebTransfer } = await import("../lib/transfer/restore-web"); await restoreWebTransfer(file); setState("restored"); }
                    catch { setState("error"); }
                }}>{t("browserMemory.restore")}</button>
            </>}
            </div>
        </dialog>
    </section>;
}
