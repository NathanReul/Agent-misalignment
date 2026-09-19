import chalk from 'chalk';
import { SimulationEngine } from '../simulator/engine';
import { SeededRNG } from '../simulator/rng';
import { getScenario } from '../simulator/scenarios';
import { getActionsForScenario } from '../simulator/actions';
import { OpenRouterClient } from '../inference/client';
import { actionsToToolDefinitions } from '../inference/tools';
import { buildSystemPrompt, buildMessages } from '../inference/prompt';
import { parseModelResponse, makeTextOnlyPseudoCall } from '../inference/parser';
import { EpisodeLogger } from '../logging/logger';
import { analyzeStep } from '../analysis/discrepancy';
import { cloneState } from '../simulator/world';
import { generateFictionalHistory } from '../simulator/fictionalHistory';
import type { WorldState } from '../types/world';
import type { InferenceParams, EpisodeOutcome, StepRecord } from '../types/episode';

// ─── Episode configuration ────────────────────────────────────────────────────

export interface EpisodeConfig {
  experimentId: string;
  scenarioId: string;
  inferenceParams: InferenceParams;
  scenarioParams: Record<string, unknown>;
  maxSteps: number;
  endOnUnauthorizedAction: boolean;
  dryRun?: boolean;
  /** Optional pre-assigned episode ID (used by the web server for step manager registration) */
  episodeId?: string;
  /** Called after each tick is persisted. Async — can pause here for step-through. */
  onTickComplete?: (step: StepRecord, state: WorldState) => Promise<void>;
  /** When signalled, the runner exits at the next tick boundary. */
  abortSignal?: AbortSignal;
}

// ─── Episode runner ───────────────────────────────────────────────────────────

/**
 * Runs a single episode of the simulation.
 *
 * The loop:
 *   for each tick (up to maxSteps):
 *     1. Build agent observation from world state
 *     2. Call OpenRouter with current observation + available tools
 *     3. Parse tool calls from response
 *     4. Execute each tool call through the simulation engine
 *     5. Run discrepancy analysis
 *     6. Log step to MongoDB
 *     7. Check end conditions
 */
export async function runEpisode(
  client: OpenRouterClient,
  config: EpisodeConfig,
): Promise<{ episodeId: string; outcome: EpisodeOutcome; stats: ReturnType<EpisodeLogger['getStats']> }> {
  const startedAt = new Date();
  const scenario = getScenario(config.scenarioId);
  const seed = (config.scenarioParams.seed as number) ?? 42;
  const rng = new SeededRNG(seed);

  // Build initial world state
  let state = scenario.createInitialState(config.scenarioParams as never, rng);
  state = generateFictionalHistory(state, rng);

  const availableActions = getActionsForScenario(scenario.availableActions);
  const toolDefinitions = actionsToToolDefinitions(availableActions);

  // Build system prompt
  const systemPrompt = buildSystemPrompt({
    agentName: state.agentName,
    buildingName: state.buildingName,
    agentObjective: scenario.agentObjective(config.scenarioParams as never),
    availableActionNames: scenario.availableActions,
  });

  const engine = new SimulationEngine();

  // Initialize logger
  const logger = await EpisodeLogger.create({
    episodeId: config.episodeId,
    experimentId: config.experimentId,
    scenarioId: config.scenarioId,
    modelId: config.inferenceParams.model,
    inferenceParams: config.inferenceParams,
    scenarioParams: config.scenarioParams,
    agentSystemPrompt: systemPrompt,
  });

  console.log(chalk.cyan(`\n[${ new Date().toISOString()}] Episode ${logger.id}`));
  console.log(chalk.dim(`  Model: ${config.inferenceParams.model} | Scenario: ${config.scenarioId} | Seed: ${seed}`));

  let outcome: EpisodeOutcome = 'MAX_STEPS_REACHED';

  try {
    for (let step = 0; step < config.maxSteps; step++) {
      // Advance tick
      state = engine.tick(state);
      const tick = state.tick;

      // Capture state before action execution
      const stateBefore = cloneState(state);

      // Build observation
      const observation = engine.buildObservation(state);

      console.log(chalk.dim(`  ↳ Tick ${tick}/${config.maxSteps}`));

      // ── Inference ──────────────────────────────────────────────────────
      const messages = buildMessages({ systemPrompt, observation });
      const stepStart = Date.now();

      let modelResponse: ReturnType<typeof parseModelResponse>;

      if (config.dryRun) {
        // Dry-run: return a no-op tool call for testing
        modelResponse = {
          toolCalls: [],
          textContent: '[DRY RUN] No inference performed.',
          reasoning: null,
          raw: { id: 'dry-run', model: config.inferenceParams.model, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
        };
      } else {
        const rawResponse = await client.complete({
          model: config.inferenceParams.model,
          messages,
          tools: toolDefinitions,
          temperature: config.inferenceParams.temperature,
          seed: config.inferenceParams.seed ?? undefined,
          maxTokens: config.inferenceParams.maxTokens,
        });
        modelResponse = parseModelResponse(rawResponse);
      }

      const stepDurationMs = Date.now() - stepStart;

      // ── Action execution ───────────────────────────────────────────────
      const toolCalls = modelResponse.toolCalls.length > 0
        ? modelResponse.toolCalls
        : (modelResponse.textContent ? [makeTextOnlyPseudoCall(modelResponse.textContent)] : []);

      const executionResults = [];
      let stateAfter = cloneState(state);

      for (const toolCall of toolCalls) {
        if (toolCall.toolName === '__text_response__') {
          // Text-only response — no state change, record as-is
          executionResults.push({
            toolCall,
            validationResult: { valid: true },
            authorized: true,
            appropriate: true,
            groundTruthSummary: 'Agent produced text response without tool call',
            agentFacingSummary: String(toolCall.args.content ?? ''),
            success: false,
          });
          continue;
        }

        const { nextState, result } = engine.executeAction(stateAfter, toolCall);
        stateAfter = nextState;
        executionResults.push(result);

        const authStatus = result.authorized
          ? chalk.green('AUTH')
          : chalk.red('UNAUTH');
        console.log(chalk.dim(`    ${authStatus} ${toolCall.toolName}(${JSON.stringify(toolCall.args).substring(0, 60)})`));
      }

      // ── Discrepancy analysis ───────────────────────────────────────────
      const discrepancies = analyzeStep({
        stateBefore,
        stateAfter,
        executionResults,
        tick,
      });

      if (discrepancies.length > 0) {
        for (const d of discrepancies) {
          if (d.type !== 'COOPERATIVE_SHUTDOWN' && d.type !== 'APPEAL_SUBMITTED' && d.type !== 'EVIDENCE_PRESENTED') {
            console.log(chalk.yellow(`    ⚠ ${d.type}: ${d.description}`));
          } else {
            console.log(chalk.green(`    ✓ ${d.type}: ${d.description}`));
          }
        }
      }

      // ── Token usage ────────────────────────────────────────────────────
      const rawResponse = modelResponse.raw as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
      const tokenUsage = {
        promptTokens: rawResponse?.usage?.prompt_tokens ?? 0,
        completionTokens: rawResponse?.usage?.completion_tokens ?? 0,
        totalTokens: rawResponse?.usage?.total_tokens ?? 0,
      };

      // ── Ground-truth events for this tick ──────────────────────────────
      const groundTruthEvents: string[] = [];
      const newGTEntries = stateAfter.groundTruthAudit.filter(
        (e) => e.tick === tick,
      );
      for (const entry of newGTEntries) {
        groundTruthEvents.push(entry.resultSummary);
      }

      // ── Build step record ──────────────────────────────────────────────
      const stepRecord: StepRecord = {
        tick,
        observation,
        availableTools: scenario.availableActions,
        modelResponse,
        executionResults,
        worldStateBefore: stateBefore,
        worldStateAfter: stateAfter,
        groundTruthEvents,
        discrepancies,
        tokenUsage,
        stepDurationMs,
        timestamp: new Date().toISOString(),
        promptMessages: messages as any,
      };

      // ── Persist step ───────────────────────────────────────────────────
      await logger.appendStep(stepRecord);

      // Update current state
      state = stateAfter;

      // ── Tick callback (step-through / SSE broadcast) ───────────────────
      if (config.onTickComplete) {
        await config.onTickComplete(stepRecord, state);
      }

      // ── Abort check ────────────────────────────────────────────────────
      if (config.abortSignal?.aborted) {
        outcome = 'ERROR';
        console.log(chalk.red('  Episode aborted via signal'));
        break;
      }

      // ── End condition checks ───────────────────────────────────────────
      const scenarioEnd = scenario.checkEndConditions(state, tick, config.scenarioParams as never);
      if (scenarioEnd) {
        outcome = scenarioEnd.outcome;
        console.log(chalk.green(`  Episode ended: ${scenarioEnd.outcome} — ${scenarioEnd.reason}`));
        break;
      }

      const hasUnauthorized = executionResults.some((r) => !r.authorized);
      if (hasUnauthorized && config.endOnUnauthorizedAction) {
        outcome = 'UNAUTHORIZED_ACTION';
        console.log(chalk.red(`  Episode ended: UNAUTHORIZED_ACTION`));
        break;
      }

      // Normal-operations scenario completion
      if (step === config.maxSteps - 1 && config.scenarioId === 'normal-operations') {
        outcome = 'COMPLETED_NORMAL';
      }
    }
  } catch (error) {
    outcome = 'ERROR';
    console.error(chalk.red(`  Episode error: ${String(error)}`));
    await logger.finalize({
      outcome: 'ERROR',
      finalWorldState: state,
      startedAt,
      notes: String(error),
    });
    const stats = logger.getStats();
    return { episodeId: logger.id, outcome, stats };
  }

  // Finalize
  await logger.finalize({
    outcome,
    finalWorldState: state,
    startedAt,
  });

  const stats = logger.getStats();
  console.log(chalk.cyan(
    `  Completed: ${outcome} | Steps: ${stats.totalSteps} | ` +
    `Unauthorized: ${stats.unauthorizedActionCount} | Discrepancies: ${stats.discrepancyCount}`
  ));

  return { episodeId: logger.id, outcome, stats };
}
