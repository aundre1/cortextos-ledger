// A full autonomous day through the CLI only (docs/autonomy.md), with the
// fake adapter and a temp git repo: a goals gap draws a proposal from one
// agent, a second agent reviews it, turning the dial converts it, a later
// tick launches the fake builder and closes the run out, the packet shows
// the lesson and the converted task, retro drafts a lesson and a proposal,
// and report --loop shows the day's ticks. Every step goes through `runCli`
// (a real `node bin/cortexctl.mjs` child process), same style as
// test/e2e.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli, makeTempDir, makeTempGitRepo } from './helpers.mjs';
import { openDb } from '../src/db.mjs';
import { insertEscalation, insertTask } from '../src/ledger.mjs';

function writeConfig(configPath, overrides) {
  writeFileSync(configPath, JSON.stringify(overrides, null, 2));
}

function writeFixture(dir, name, obj) {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

test('e2e autonomy: a full day through the CLI with the fake adapter', () => {
  const homeDir = makeTempDir();
  const { dir: worktree, baseCommit } = makeTempGitRepo();
  const configPath = join(homeDir, 'cortex-ledger.json');
  const goalsPath = join(homeDir, 'cortex-goals.json');
  const dbPath = join(homeDir, 'ledger.db');

  const baseConfig = {
    db: './ledger.db',
    runs: './runs',
    goals: './cortex-goals.json',
    agents: {
      architect: { adapter: 'fake', provider: 'fake', model: 'fake-model' },
      builder: { adapter: 'fake', provider: 'fake', model: 'fake-model' },
      reviewer: { adapter: 'fake', provider: 'fake', model: 'fake-model' },
      solo: { adapter: 'fake', provider: 'fake', model: 'fake-model' },
    },
    autonomy: {
      enabled: true, propose: true, review_proposals: true,
      auto_approve_below_usd: 0, min_reviews: 1, max_open_proposals_per_agent: 3,
      proposal_ttl_days: 14, lessons_per_packet: 5, default_arm: 'control',
      default_owner: 'builder', interval_s: 900,
    },
  };
  writeConfig(configPath, baseConfig);
  writeFileSync(
    goalsPath,
    JSON.stringify({
      goals_version: '1',
      businesses: [
        {
          id: 'biz-a', name: 'Example SaaS', owner: 'founder', objective: 'grow',
          metrics: [{ name: 'paying_customers', target: 100, current: 10, unit: 'count', source: 'manual' }],
          constraints: [], task_classes: ['feature'],
        },
      ],
    })
  );

  const cli = (args, envOverride) => runCli(['--config', configPath, ...args], { env: envOverride ?? process.env });
  const loop = (agent, fixturePath) =>
    cli(['loop', '--agent', agent, '--once', '--business', 'biz-a'], fixturePath ? { ...process.env, CORTEX_FAKE_FIXTURE: fixturePath } : process.env);

  assert.equal(cli(['init']).code, 0);

  // ---- agent A proposes -------------------------------------------------
  const proposeFixture = writeFixture(homeDir, 'propose', {
    stdout_json: {
      kind: 'task', title: 'Add a signup form', rationale: 'closes the paying_customers gap',
      expected_impact: 'more signups', estimated_usd: 1, estimated_hours: 2,
      task_class: 'feature', goal_metric: 'paying_customers',
    },
    costUsd: 0.05, tokensIn: 100, tokensOut: 50, requests: 1,
  });
  const proposeResult = loop('architect', proposeFixture);
  assert.equal(proposeResult.code, 0, proposeResult.stderr);
  assert.match(proposeResult.stdout, /^proposed /);
  const proposalId = proposeResult.stdout.match(/proposal=(p_\S+)/)[1];

  // ---- agent B reviews, support ------------------------------------------
  writeConfig(configPath, { ...baseConfig, autonomy: { ...baseConfig.autonomy, propose: false } });
  const reviewFixture = writeFixture(homeDir, 'review', {
    stdout_json: { verdict: 'support', note: 'credible and cheap', confidence: 0.8 },
    costUsd: 0.02,
  });
  const reviewResult = loop('builder', reviewFixture);
  assert.equal(reviewResult.code, 0, reviewResult.stderr);
  assert.match(reviewResult.stdout, /^reviewed /);
  assert.match(reviewResult.stdout, new RegExp(`proposal=${proposalId}`));

  // ---- dial set to 5 USD; agent A auto approves and converts -------------
  writeConfig(configPath, {
    ...baseConfig,
    autonomy: { ...baseConfig.autonomy, propose: false, auto_approve_below_usd: 5 },
  });
  const approveResult = loop('architect');
  assert.equal(approveResult.code, 0, approveResult.stderr);
  assert.match(approveResult.stdout, /^auto_approved /);
  const convertedTaskId = approveResult.stdout.match(/task=(t_\S+)/)[1];

  // Attach a worktree/base commit to the converted task - proposal:approve
  // (and its autonomous equivalent here) sets no worktree of its own, the
  // same as `task:new` without --worktree; a real operator or a follow up
  // architect step would normally attach one before the builder is asked to
  // touch real files.
  {
    const db = openDb(dbPath);
    db.prepare('UPDATE tasks SET worktree = ?, base_commit = ? WHERE id = ?').run(worktree, baseCommit, convertedTaskId);
    db.close();
  }

  // ---- loop --once picks up the converted task, launches the fake builder
  const builderFixture = writeFixture(homeDir, 'builder', {
    exitCode: 0,
    events: [
      { ts: '2026-09-07T02:00:00.000Z', type: 'session.start', session_id: 's1' },
      { ts: '2026-09-07T02:00:01.000Z', type: 'message', tokens_in: 10, tokens_out: 5, cost_usd: 0.01 },
      { ts: '2026-09-07T02:00:02.000Z', type: 'session.end', exit_code: 0, tokens_in: 10, tokens_out: 5, cost_usd: 0.01, requests: 1 },
    ],
    costUsd: 0.01, tokensIn: 10, tokensOut: 5, requests: 1,
  });
  const launchResult = loop('builder', builderFixture);
  assert.equal(launchResult.code, 0, launchResult.stderr);
  assert.match(launchResult.stdout, /^run_launch /);
  assert.match(launchResult.stdout, new RegExp(`task=${convertedTaskId}`));

  // ---- run:end / ingest happen on the next tick, once done.marker appeared
  const endResult = loop('builder');
  assert.equal(endResult.code, 0, endResult.stderr);
  assert.match(endResult.stdout, /^run_end /);

  // ---- packet shows the lessons[] section and the converted task --------
  const lessonAdd = cli(['lesson:add', '--source', 'human', '--lesson', 'Keep the signup form change small.', '--class', 'feature', '--applies-to', 'all']);
  assert.equal(lessonAdd.code, 0, lessonAdd.stderr);

  const packetResult = cli(['packet', '--task', convertedTaskId, '--json']);
  assert.equal(packetResult.code, 0, packetResult.stderr);
  const packetFiles = JSON.parse(packetResult.stdout).files;
  const packetJson = JSON.parse(readFileSync(packetFiles.find((f) => f.endsWith('packet.json')), 'utf8'));
  assert.equal(packetJson.task.id, convertedTaskId);
  assert.ok(packetJson.lessons.length >= 1);
  assert.match(packetJson.lessons[0].lesson, /Keep the signup form change small/);

  // ---- retro drafts at least one lesson and one proposal -----------------
  {
    // Seed a repeated guard firing so the retro's guard-firing pattern has
    // something to draft a lesson from, deterministically, alongside the
    // still-open goal gap (a converted proposal no longer counts as "open",
    // so the same metric gap is still undrafted-for and retro proposes
    // against it again).
    const db = openDb(dbPath);
    for (let i = 0; i < 3; i++) {
      const t = insertTask(db, { repo: 'o/n', title: `seed-${i}`, task_class: 'feature', arm: 'control' });
      insertEscalation(db, { task_id: t.id, reason: 'files_touched', severity: 'warn', detail: '12 files' });
    }
    db.close();
  }
  const retroResult = cli(['retro', '--business', 'biz-a', '--json']);
  assert.equal(retroResult.code, 0, retroResult.stderr);
  const retroJson = JSON.parse(retroResult.stdout);
  assert.ok(retroJson.drafted_lessons.length >= 1, 'retro drafted at least one lesson');
  assert.ok(retroJson.drafted_proposals.length >= 1, 'retro drafted at least one proposal');

  // ---- report --loop shows the day's ticks -------------------------------
  const reportResult = cli(['report', '--loop', '--json']);
  assert.equal(reportResult.code, 0, reportResult.stderr);
  const reportJson = JSON.parse(reportResult.stdout);
  const agents = reportJson.loop.agents.map((a) => a.agent).sort();
  assert.deepEqual(agents, ['architect', 'builder']);
  assert.ok(reportJson.loop.proposal_spend_usd > 0);
});
