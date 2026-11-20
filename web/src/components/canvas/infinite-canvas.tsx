import React, { useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onPinchStart?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

function getPinch(touches: Map<number, { x: number; y: number }>) {
    if (touches.size < 2) return null;
    const [first, second] = touches.values();
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)) };
}

export function InfiniteCanvas({ containerRef, viewport, tool, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onPinchStart, onCanvasDoubleClick, onContextMenu, onDrop, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        pointerId: -1,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    const viewportRef = useRef(viewport);
    const touchesRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchRef = useRef<ReturnType<typeof getPinch>>(null);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isControlPressed, setIsControlPressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useEffect(() => {
        viewportRef.current = viewport;
    }, [viewport]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Control") setIsControlPressed(true);
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
            if (event.key === "Control") setIsControlPressed(false);
        };

        const handleBlur = () => {
            setIsSpacePressed(false);
            setIsControlPressed(false);
            panState.current.isPanning = false;
            touchesRef.current.clear();
            pinchRef.current = null;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const newScale = Math.min(Math.max(viewport.k * factor, 0.05), 5);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - viewport.x) / viewport.k;
        const worldY = (mouseY - viewport.y) / viewport.k;

        onViewportChange({
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        });
    };

    const handleTouchStart = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType !== "touch" || !event.currentTarget.contains(event.target as Node)) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-connection-create-menu],button,a,input,textarea,select,[contenteditable],video,audio,iframe")) return;
        const touches = touchesRef.current;
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.size < 2) return;

        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        if (touches.size === 2) {
            pinchRef.current = getPinch(touches);
            panState.current.isPanning = false;
            setIsPanning(false);
            onPinchStart?.();
        }
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        const temporaryTool = event.ctrlKey || isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && isBackgroundClick && (event.pointerType === "touch" || activeTool === "pan"));

        if (shouldPan) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const currentViewport = nextViewportRef.current ?? viewportRef.current;
            panState.current = {
                isPanning: true,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                initialX: currentViewport.x,
                initialY: currentViewport.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            setIsPanning(true);
            if (event.pointerType !== "touch") document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const queueViewport = (next: ViewportTransform) => {
            nextViewportRef.current = next;
            if (frameRef.current !== null) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                const pending = nextViewportRef.current;
                nextViewportRef.current = null;
                if (!pending) return;
                viewportRef.current = pending;
                onViewportChange(pending);
            });
        };

        const handlePointerMove = (event: PointerEvent) => {
            const touches = touchesRef.current;
            if (touches.has(event.pointerId)) {
                touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
                const previous = pinchRef.current;
                const pinch = getPinch(touches);
                const bounds = pinch && containerRef.current?.getBoundingClientRect();
                if (previous && pinch && bounds) {
                    const current = nextViewportRef.current ?? viewportRef.current;
                    const k = Math.min(5, Math.max(0.05, current.k * pinch.distance / previous.distance));
                    const ratio = k / current.k;
                    pinchRef.current = pinch;
                    queueViewport({ x: pinch.x - bounds.left - (previous.x - bounds.left - current.x) * ratio, y: pinch.y - bounds.top - (previous.y - bounds.top - current.y) * ratio, k });
                    return;
                }
            }

            if (!panState.current.isPanning || panState.current.pointerId !== event.pointerId) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            if (!panState.current.hasMoved) return;
            queueViewport({
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: viewportRef.current.k,
            });
        };

        const handlePointerUp = (event: PointerEvent) => {
            if (touchesRef.current.delete(event.pointerId)) pinchRef.current = getPinch(touchesRef.current);
            if (!panState.current.isPanning || panState.current.pointerId !== event.pointerId) return;

            if (event.type === "pointerup" && !panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [containerRef, onCanvasDeselect, onViewportChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Prevent canvas scrolling from moving the page while preserving native scrolling inside overlays and dialogs.
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    const temporaryTool = isControlPressed || isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDownCapture={handleTouchStart}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <div className="absolute inset-0 touch-none" />
            <CanvasGrid viewport={viewport} mode={backgroundMode} />
            <div
                className="absolute origin-top-left"
                style={{
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
