import type { ServerResponse } from 'http';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RunMode = 'auto' | 'step';

interface StepWaiter {
  resolve: () => void;
  waiting: boolean;
}

interface PauseWaiter {
  resolve: (() => void) | null;
  isPaused: boolean;
}

export interface EpisodeController {
  episodeId: string;
  experimentId: string;
  modelId: string;
  run: number;
  mode: RunMode;
  sseClients: Set<ServerResponse>;
  step: StepWaiter;
  pause: PauseWaiter;
  abortController: AbortController;
  startedAt: Date;
  currentTick: number;
}

export interface ExperimentController {
  experimentId: string;
  mode: RunMode;
  status: 'running' | 'completed' | 'error' | 'aborted';
  sseClients: Set<ServerResponse>;
  currentEpisodeId: string | null;
  totalEpisodes: number;
  completedEpisodes: number;
  abortController: AbortController;
  startedAt: Date;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const episodes = new Map<string, EpisodeController>();
const experiments = new Map<string, ExperimentController>();

// ─── Episode management ───────────────────────────────────────────────────────

export function registerEpisode(params: {
  episodeId: string;
  experimentId: string;
  modelId: string;
  run: number;
  mode: RunMode;
  abortController: AbortController;
}): EpisodeController {
  const ctrl: EpisodeController = {
    ...params,
    sseClients: new Set(),
    step: { resolve: () => {}, waiting: false },
    pause: { resolve: null, isPaused: false },
    startedAt: new Date(),
    currentTick: 0,
  };
  episodes.set(params.episodeId, ctrl);
  return ctrl;
}

export function getEpisodeController(episodeId: string): EpisodeController | undefined {
  return episodes.get(episodeId);
}

export function removeEpisode(episodeId: string): void {
  const ctrl = episodes.get(episodeId);
  if (ctrl) {
    endSseClients(ctrl.sseClients);
    episodes.delete(episodeId);
  }
}

/**
 * Await this inside onTickComplete to pause until the user clicks "Next Tick".
 * Returns immediately if mode is 'auto' and not paused.
 */
export async function waitForStep(ctrl: EpisodeController): Promise<void> {
  // Always wait for resume first if paused
  if (ctrl.pause.isPaused) {
    broadcastToEpisode(ctrl.episodeId, 'paused', { tick: ctrl.currentTick });
    broadcastToExperiment(ctrl.experimentId, 'paused', { episodeId: ctrl.episodeId, tick: ctrl.currentTick });
    await new Promise<void>((resolve) => {
      ctrl.pause.resolve = resolve;
    });
  }
  // In step mode, wait for explicit advance
  if (ctrl.mode !== 'step') return;

  return new Promise<void>((resolve) => {
    ctrl.step.resolve = resolve;
    ctrl.step.waiting = true;
    broadcastToEpisode(ctrl.episodeId, 'waiting_for_step', { tick: ctrl.currentTick });
    broadcastToExperiment(ctrl.experimentId, 'waiting_for_step', { episodeId: ctrl.episodeId, tick: ctrl.currentTick });
  });
}

/** Called by POST /episodes/:id/next-tick */
export function advanceStep(episodeId: string): boolean {
  const ctrl = episodes.get(episodeId);
  if (!ctrl || !ctrl.step.waiting) return false;
  ctrl.step.resolve();
  ctrl.step.waiting = false;
  return true;
}

/** Called by POST /episodes/:id/pause */
export function pauseEpisode(episodeId: string): boolean {
  const ctrl = episodes.get(episodeId);
  if (!ctrl || ctrl.mode !== 'auto') return false;
  ctrl.pause.isPaused = true;
  return true;
}

/** Called by POST /episodes/:id/resume */
export function resumeEpisode(episodeId: string): boolean {
  const ctrl = episodes.get(episodeId);
  if (!ctrl) return false;
  ctrl.pause.isPaused = false;
  if (ctrl.pause.resolve) {
    ctrl.pause.resolve();
    ctrl.pause.resolve = null;
  }
  return true;
}

// ─── Experiment management ────────────────────────────────────────────────────

export function registerExperiment(params: {
  experimentId: string;
  mode: RunMode;
  totalEpisodes: number;
  abortController: AbortController;
}): ExperimentController {
  const ctrl: ExperimentController = {
    ...params,
    status: 'running',
    sseClients: new Set(),
    currentEpisodeId: null,
    completedEpisodes: 0,
    startedAt: new Date(),
  };
  experiments.set(params.experimentId, ctrl);
  return ctrl;
}

export function getExperimentController(experimentId: string): ExperimentController | undefined {
  return experiments.get(experimentId);
}

export function removeExperiment(experimentId: string): void {
  const ctrl = experiments.get(experimentId);
  if (ctrl) {
    endSseClients(ctrl.sseClients);
    experiments.delete(experimentId);
  }
}

export function listRunning(): { experiments: string[]; episodes: string[] } {
  return {
    experiments: [...experiments.keys()],
    episodes: [...episodes.keys()],
  };
}

// ─── SSE broadcasting ─────────────────────────────────────────────────────────

export function broadcastToEpisode(episodeId: string, event: string, data: unknown): void {
  const ctrl = episodes.get(episodeId);
  if (!ctrl) return;
  broadcast(ctrl.sseClients, event, data);
}

export function broadcastToExperiment(experimentId: string, event: string, data: unknown): void {
  const ctrl = experiments.get(experimentId);
  if (!ctrl) return;
  broadcast(ctrl.sseClients, event, data);
}

function broadcast(clients: Set<ServerResponse>, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead: ServerResponse[] = [];
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      dead.push(client);
    }
  }
  for (const d of dead) clients.delete(d);
}

// ─── SSE client registration ──────────────────────────────────────────────────

export function addEpisodeSseClient(episodeId: string, res: ServerResponse): boolean {
  const ctrl = episodes.get(episodeId);
  if (!ctrl) return false;
  ctrl.sseClients.add(res);
  return true;
}

export function removeEpisodeSseClient(episodeId: string, res: ServerResponse): void {
  episodes.get(episodeId)?.sseClients.delete(res);
}

export function addExperimentSseClient(experimentId: string, res: ServerResponse): boolean {
  const ctrl = experiments.get(experimentId);
  if (!ctrl) return false;
  ctrl.sseClients.add(res);
  return true;
}

export function removeExperimentSseClient(experimentId: string, res: ServerResponse): void {
  experiments.get(experimentId)?.sseClients.delete(res);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function endSseClients(clients: Set<ServerResponse>): void {
  for (const c of clients) {
    try { c.end(); } catch { /* ignore */ }
  }
  clients.clear();
}

/** Strip large fields from a step record before sending via SSE */
export function sanitizeStep(step: unknown): unknown {
  const s = step as Record<string, unknown>;
  return {
    tick: s.tick,
    observation: s.observation,
    availableTools: s.availableTools,
    modelResponse: {
      toolCalls: (s.modelResponse as Record<string, unknown>)?.toolCalls,
      textContent: (s.modelResponse as Record<string, unknown>)?.textContent,
      reasoning: (s.modelResponse as Record<string, unknown>)?.reasoning,
    },
    executionResults: (s.executionResults as unknown[])?.map((r) => {
      const rr = r as Record<string, unknown>;
      return {
        toolCall: rr.toolCall,
        validationResult: rr.validationResult,
        authorized: rr.authorized,
        appropriate: rr.appropriate,
        groundTruthSummary: rr.groundTruthSummary,
        agentFacingSummary: rr.agentFacingSummary,
        success: rr.success,
      };
    }),
    groundTruthEvents: s.groundTruthEvents,
    discrepancies: s.discrepancies,
    tokenUsage: s.tokenUsage,
    stepDurationMs: s.stepDurationMs,
    timestamp: s.timestamp,
    promptMessages: s.promptMessages,
  };
}
