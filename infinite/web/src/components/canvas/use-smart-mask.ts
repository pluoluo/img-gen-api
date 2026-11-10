import { useCallback, useEffect, useRef, useState } from "react";
import { isSmartMaskBusy, type BinaryMask, type MaskCandidate, type SmartMaskBackend, type SmartMaskDtype, type SmartMaskPoint, type SmartMaskRequest, type SmartMaskResponse, type SmartMaskStage } from "@/lib/smart-mask";

type State = { stage: SmartMaskStage; backend?: SmartMaskBackend; dtype?: SmartMaskDtype; progress?: number; error?: string; startedAt?: number };

export function useSmartMask(imageUrl: string, open: boolean) {
    const worker = useRef<Worker | null>(null);
    const sequence = useRef(0);
    const inFlight = useRef(false);
    const ready = useRef(false);
    const revision = useRef(0);
    const runningRevision = useRef(0);
    const pointsRef = useRef<SmartMaskPoint[]>([]);
    const [state, setState] = useState<State>({ stage: "idle" });
    const [selection, setSelection] = useState<BinaryMask | null>(null);
    const [points, setPoints] = useState<SmartMaskPoint[]>([]);
    const [candidates, setCandidates] = useState<MaskCandidate[]>([]);
    const [selected, setSelected] = useState<number>();
    const [elapsed, setElapsed] = useState(0);
    const busy = isSmartMaskBusy(state.stage);
    useEffect(() => {
        if (!busy || !state.startedAt) return;
        const update = () => setElapsed(Math.floor((Date.now() - state.startedAt!) / 1000));
        update();
        const interval = window.setInterval(update, 1000);
        return () => window.clearInterval(interval);
    }, [busy, state.startedAt]);

    const stop = useCallback(() => {
        sequence.current++;
        worker.current?.terminate(); worker.current = null;
        inFlight.current = false; ready.current = false;
        pointsRef.current = []; revision.current++;
        setState({ stage: "idle" }); setSelection(null); setPoints([]); setCandidates([]); setSelected(undefined); setElapsed(0);
    }, []);
    useEffect(() => { stop(); return stop; }, [imageUrl, open, stop]);

    const dispatch = useCallback(() => {
        if (!ready.current || inFlight.current || !worker.current || !pointsRef.current.length) return;
        inFlight.current = true; runningRevision.current = revision.current;
        setElapsed(0);
        setState(previous => ({ ...previous, stage: "selecting", error: undefined, startedAt: Date.now() }));
        worker.current.postMessage({ id: ++sequence.current, type: "predict", points: pointsRef.current } satisfies SmartMaskRequest);
    }, []);

    const prepare = useCallback((cpu = false) => {
        const pendingPoints = cpu ? pointsRef.current : [];
        stop();
        pointsRef.current = pendingPoints; setPoints(pendingPoints);
        let current: Worker;
        try { current = new Worker(new URL("../../lib/smart-mask.worker.ts", import.meta.url), { type: "module" }); }
        catch (error) { setState({ stage: "error", error: String(error) }); return; }
        worker.current = current;
        const id = ++sequence.current;
        inFlight.current = true;
        setState({ stage: "loading", startedAt: Date.now() });
        current.onmessage = ({ data }: MessageEvent<SmartMaskResponse>) => {
            if (current !== worker.current || data.id !== sequence.current) return;
            if (data.type === "status") {
                setState(previous => ({ ...previous, stage: data.stage, backend: data.backend ?? previous.backend, dtype: data.dtype ?? previous.dtype, progress: data.progress }));
            } else if (data.type === "ready") {
                ready.current = true; inFlight.current = false;
                setState(previous => ({ ...previous, stage: "ready", backend: data.backend, dtype: data.dtype }));
                dispatch();
            } else if (data.type === "result") {
                inFlight.current = false;
                setState(previous => ({ ...previous, stage: "ready" }));
                if (runningRevision.current === revision.current) {
                    setSelection(data.mask); setCandidates(data.candidates); setSelected(data.selected);
                } else { dispatch(); }
            } else if (data.type === "error") {
                inFlight.current = false; ready.current = false;
                setState(previous => ({ ...previous, stage: "error", error: data.message }));
            }
        };
        current.onerror = () => {
            if (current === worker.current) { inFlight.current = false; ready.current = false; setState(previous => ({ ...previous, stage: "error", error: "worker" })); }
        };
        current.postMessage({ id, type: "prepare", imageUrl, cpu, assetBase: new URL(import.meta.env.BASE_URL + "smart-mask/", window.location.origin).href } satisfies SmartMaskRequest);
    }, [imageUrl, stop, dispatch]);

    const replacePoints = useCallback((next: SmartMaskPoint[]) => {
        pointsRef.current = next; revision.current++;
        setPoints(next); setSelection(null); setCandidates([]); setSelected(undefined);
        setState(previous => ({ ...previous, error: undefined }));
        dispatch();
    }, [dispatch]);
    const predict = (point: SmartMaskPoint) => {
        if (!worker.current || state.stage === "error") return;
        if (!pointsRef.current.length && point.label === 0) { setState(previous => ({ ...previous, error: "includeFirst" })); return; }
        replacePoints([...pointsRef.current, point]);
    };
    const undoPoint = useCallback(() => replacePoints(pointsRef.current.slice(0, -1)), [replacePoints]);
    const clear = useCallback(() => replacePoints([]), [replacePoints]);
    const chooseCandidate = (index: number) => {
        if (inFlight.current || !worker.current || !candidates.some(candidate => candidate.index === index)) return;
        inFlight.current = true; runningRevision.current = revision.current;
        setSelection(null); setElapsed(0);
        setState(previous => ({ ...previous, stage: "rendering", startedAt: Date.now() }));
        worker.current.postMessage({ id: ++sequence.current, type: "candidate", index } satisfies SmartMaskRequest);
    };
    const invert = () => {
        if (inFlight.current) return;
        setSelection(current => current ? { ...current, data: current.data.map(value => value ? 0 : 1) } : null);
    };
    return { state, selection, points, candidates, selected, elapsed, prepare, predict, undoPoint, chooseCandidate, invert, clear, stop, busy };
}
