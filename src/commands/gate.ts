/**
 * Gate Command
 *
 * Executes quality gates defined in a schema's apply phase.
 * Usage: openspec gate run <pre|post> --change <name>
 */

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { resolveSchema } from '../core/artifact-graph/resolver.js';
import { getChangeDir, resolveCurrentPlanningHomeSync } from '../core/planning-home.js';
import { validateChangeExists } from './workflow/shared.js';
import { loadChangeContext } from '../core/artifact-graph/index.js';

interface GateResult {
  id: string;
  description: string;
  run: string;
  level: 'required' | 'optional';
  stage: 'pre' | 'post';
  status: 'pass' | 'fail' | 'skip';
  output?: string;
}

async function runGates(
  stage: 'pre' | 'post',
  changeName: string,
  projectRoot: string,
  options: { json?: boolean; all?: boolean }
): Promise<void> {
  const planningHome = resolveCurrentPlanningHomeSync({ startPath: projectRoot });

  const context = loadChangeContext(projectRoot, changeName, undefined, {
    changeDir: getChangeDir(planningHome, changeName),
    planningHome,
  });
  const schema = resolveSchema(context.schemaName, projectRoot);
  const gates = schema.apply?.gates ?? [];

  // Filter gates by stage
  const stageGates = gates.filter((g) => g.stage === stage);

  if (stageGates.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({
        stage,
        changeName,
        schemaName: context.schemaName,
        results: [],
        summary: { requiredPassed: 0, requiredTotal: 0, optionalPassed: 0, optionalTotal: 0, passed: true },
      }, null, 2));
    } else {
      console.log(`No ${stage}-implementation gates defined for schema '${context.schemaName}'.`);
    }
    return;
  }

  if (!options.json) {
    console.log(`\n=== ${stage === 'pre' ? 'Pre-Implementation' : 'Post-Implementation'} Gates ===\n`);
  }

  const results: GateResult[] = [];
  let priorRequiredFailed = false;

  for (const gate of stageGates) {
    // Skip optional gates if a prior required gate failed (unless --all)
    if (gate.level === 'optional' && priorRequiredFailed && !options.all) {
      results.push({
        id: gate.id,
        description: gate.description,
        run: gate.run,
        level: gate.level,
        stage: gate.stage,
        status: 'skip',
      });
      if (!options.json) {
        console.log(`[SKIP] ${gate.description} (optional, skipped due to prior required failure)`);
      }
      continue;
    }

    let status: 'pass' | 'fail' = 'pass';
    let output: string | undefined;

    try {
      const stdout = execSync(gate.run, {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
      });
      output = stdout.trim();
      status = 'pass';
    } catch (err: unknown) {
      status = 'fail';
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      output = execErr.stderr || execErr.stdout || execErr.message || 'Unknown error';
      if (gate.level === 'required') {
        priorRequiredFailed = true;
      }
    }

    results.push({
      id: gate.id,
      description: gate.description,
      run: gate.run,
      level: gate.level,
      stage: gate.stage,
      status,
      output,
    });

    if (!options.json) {
      const tag = status === 'pass' ? '[PASS]' : '[FAIL]';
      console.log(`${tag} ${gate.description} (\`${gate.run}\`)`);
      if (status === 'fail' && output) {
        const lines = output.split('\n').slice(0, 10);
        for (const line of lines) {
          console.log(`  → ${line}`);
        }
        if (output.split('\n').length > 10) {
          console.log(`  → ... (truncated)`);
        }
      }
    }
  }

  // Summary
  const requiredResults = results.filter((r) => r.level === 'required' && r.status !== 'skip');
  const optionalResults = results.filter((r) => r.level === 'optional' && r.status !== 'skip');
  const requiredPassed = requiredResults.filter((r) => r.status === 'pass').length;
  const requiredTotal = requiredResults.length;
  const optionalPassed = optionalResults.filter((r) => r.status === 'pass').length;
  const optionalTotal = optionalResults.length;
  const allRequiredPassed = requiredPassed === requiredTotal;

  if (!options.json) {
    console.log();
    const parts: string[] = [];
    if (requiredTotal > 0) {
      parts.push(`${requiredPassed}/${requiredTotal} required passed`);
    }
    if (optionalTotal > 0) {
      parts.push(`${optionalPassed}/${optionalTotal} optional passed`);
    }
    console.log(`Result: ${parts.join(', ')}${allRequiredPassed ? '' : ' — GATE FAILURE'}`);
  } else {
    console.log(JSON.stringify({
      stage,
      changeName,
      schemaName: context.schemaName,
      results,
      summary: {
        requiredPassed,
        requiredTotal,
        optionalPassed,
        optionalTotal,
        passed: allRequiredPassed,
      },
    }, null, 2));
  }

  if (!allRequiredPassed) {
    process.exitCode = 1;
  }
}

export function registerGateCommand(program: Command): void {
  const gateCmd = program
    .command('gate')
    .description('Execute quality gates defined in a schema [experimental]');

  gateCmd.hook('preAction', () => {
    console.error('Note: Gate commands are experimental and may change.');
  });

  gateCmd
    .command('run <stage>')
    .description('Run pre or post implementation gates for a change')
    .option('--change <id>', 'Change name')
    .option('--json', 'Output as JSON')
    .option('--all', 'Execute optional gates even when a required gate has failed')
    .action(async (stage: string, options?: { change?: string; json?: boolean; all?: boolean }) => {
      try {
        if (!['pre', 'post'].includes(stage)) {
          console.error(`Error: stage must be 'pre' or 'post', got '${stage}'`);
          process.exitCode = 1;
          return;
        }

        const planningHome = resolveCurrentPlanningHomeSync();
        const projectRoot = planningHome.root;
        const changeName = await validateChangeExists(
          options?.change,
          projectRoot,
          planningHome.changesDir
        );

        await runGates(stage as 'pre' | 'post', changeName, projectRoot, {
          json: options?.json,
          all: options?.all,
        });
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });
}
