#!/usr/bin/env node
/**
 * Executes all checks defined in component_verification_contract.json
 * and produces a structured pass/fail report.
 *
 * Usage: node verify.js
 * Requires: GH_TOKEN env var (read access to GitHub Actions artifacts)
 * Output: prints report to stdout + pushes verify_report_TIMESTAMP.json to data branch
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONTRACT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "component_verification_contract.json"), "utf8")
);

const REPO = "NK5NK5/remote_mcp_hosting_provider_tools_list_latency_measurement";
const REGISTRY_URL = "https://raw.githubusercontent.com/NK5NK5/remote_mcp_hosting_provider_benchmark_pipeline_registry/main/pipeline_components.json";
const GH_TOKEN = process.env.GH_TOKEN || "";

// --local-file <path> : skip level 3, use local file for levels 4 & 5, no push
const localFileArg = process.argv.indexOf("--local-file");
const LOCAL_FILE = localFileArg !== -1 ? process.argv[localFileArg + 1] : null;
const WORKTREE_DIR = path.join(__dirname, ".verify_tmp");
const TMP_ZIP = "/tmp/verify_tools_list_artifact.zip";
const TMP_DIR = "/tmp/verify_tools_list_artifact_content";

// --- helpers ----------------------------------------------------------------

function pass(id) { return { id, status: "pass" }; }
function fail(id, reason) { return { id, status: "fail", reason }; }

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", ...opts });
}

function fetchJson(url) {
  const raw = exec(`curl -sf "${url}"`);
  return JSON.parse(raw);
}

function httpOk(url) {
  try { exec(`curl -sf "${url}" -o /dev/null`); return true; }
  catch { return false; }
}

function ghApi(path) {
  const auth = GH_TOKEN ? `-H "Authorization: Bearer ${GH_TOKEN}"` : "";
  const raw = exec(`curl -sf ${auth} "https://api.github.com${path}"`);
  return JSON.parse(raw);
}

function getMcpClient(result) {
  return result.observed_call_chain?.find((e) => e.role === "mcpclient") ?? null;
}

function getMcpServer(result) {
  return result.observed_call_chain?.find((e) => e.role === "mcpserver") ?? null;
}

function isPositiveNumber(v) {
  return typeof v === "number" && v > 0;
}

// --- level 1 — discoverability ----------------------------------------------

function checkDiscoverability() {
  const results = [];
  let registry = null;
  let entry = null;

  try {
    registry = fetchJson(CONTRACT.levels[0].checks[0].url);
    results.push(pass("registry_accessible"));
  } catch {
    results.push(fail("registry_accessible", "HTTP request failed or invalid JSON"));
    ["registry_has_component_entry", "registry_has_data_url", "component_contract_accessible"]
      .forEach((id) => results.push(fail(id, "skipped — registry not accessible")));
    return results;
  }

  entry = registry.find((c) => c.name === CONTRACT.component);
  results.push(entry
    ? pass("registry_has_component_entry")
    : fail("registry_has_component_entry", "no entry found with matching name"));

  results.push(entry?.data_url
    ? pass("registry_has_data_url")
    : fail("registry_has_data_url", "data_url field missing or empty"));

  results.push(httpOk(CONTRACT.levels[0].checks[3].url)
    ? pass("component_contract_accessible")
    : fail("component_contract_accessible", "URL not accessible"));

  return results;
}

// --- level 2 — completeness -------------------------------------------------

function checkCompleteness() {
  const results = [];

  // component_contract_valid
  try {
    const contract = fetchJson(CONTRACT.levels[0].checks[3].url);
    const required = CONTRACT.levels[1].checks[0].required_fields;
    const missing = required.filter((f) => !contract[f]);
    results.push(missing.length === 0
      ? pass("component_contract_valid")
      : fail("component_contract_valid", `missing fields: ${missing.join(", ")}`));
  } catch {
    results.push(fail("component_contract_valid", "not valid JSON or not accessible"));
  }

  // workflow_present
  try {
    const workflows = ghApi(`/repos/${REPO}/actions/workflows`);
    const found = workflows.workflows?.find((w) => w.path.includes("benchmark.yml"));
    results.push(found
      ? pass("workflow_present")
      : fail("workflow_present", "benchmark.yml not found in workflows"));
  } catch {
    results.push(fail("workflow_present", "could not reach GitHub Actions API"));
  }

  // verify_script_present
  results.push(httpOk(CONTRACT.levels[1].checks[2].url)
    ? pass("verify_script_present")
    : fail("verify_script_present", "verify.js not accessible on GitHub"));

  return results;
}

// --- load pingers from registry ---------------------------------------------

function loadPingers() {
  try {
    const registry = fetchJson(REGISTRY_URL);
    const entry = registry.find((c) => c.name === CONTRACT.component);
    return entry?.pingers ?? [];
  } catch {
    return [];
  }
}

// --- level 3 — output availability (one check set per pinger) ---------------

function checkAvailability(pingers) {
  const results = [];
  const maxAgeMs = CONTRACT.levels[2].max_age_hours * 60 * 60 * 1000;
  let artifactData = null;
  const pingerResults = [];

  for (const pinger of pingers) {
    if (pinger.data_url) {
      // verifiable — has a public data_url exposing its results
      let recentRunId = null;
      try {
        let workflowId = null;
        try {
          const workflows = ghApi(`/repos/${REPO}/actions/workflows`);
          const benchmark = workflows.workflows?.find((w) => w.path.includes("benchmark.yml"));
          workflowId = benchmark?.id ?? null;
        } catch {}
        const runsUrl = workflowId
          ? `/repos/${REPO}/actions/runs?status=success&workflow_id=${workflowId}&per_page=10`
          : `/repos/${REPO}/actions/runs?status=success&per_page=10`;
        const runs = ghApi(runsUrl);
        const now = Date.now();
        const recent = (runs.workflow_runs || []).find(
          (r) => now - new Date(r.created_at).getTime() < maxAgeMs
        );
        if (recent) {
          results.push(pass(`recent_run_succeeded_${pinger.label}`));
          recentRunId = recent.id;
        } else {
          results.push(fail(`recent_run_succeeded_${pinger.label}`, `no successful run in the last ${CONTRACT.levels[2].max_age_hours}h`));
        }
      } catch {
        results.push(fail(`recent_run_succeeded_${pinger.label}`, "could not reach pinger data_url"));
      }

      if (!recentRunId) {
        results.push(fail(`recent_artifact_exists_${pinger.label}`, "skipped — no recent successful run"));
        pingerResults.push({ label: pinger.label, tested: false, reason: "no recent successful run found" });
        continue;
      }

      try {
        const artifacts = ghApi(`/repos/${REPO}/actions/runs/${recentRunId}/artifacts`);
        if (artifacts.total_count === 0) {
          results.push(fail(`recent_artifact_exists_${pinger.label}`, "no artifacts found for the latest successful run"));
          pingerResults.push({ label: pinger.label, tested: false, reason: "no artifacts found for the latest successful run" });
          continue;
        }
        results.push(pass(`recent_artifact_exists_${pinger.label}`));

        const artifactId = artifacts.artifacts[0].id;
        const auth = GH_TOKEN ? `-H "Authorization: Bearer ${GH_TOKEN}"` : "";
        exec(`curl -sfL ${auth} "https://api.github.com/repos/${REPO}/actions/artifacts/${artifactId}/zip" -o ${TMP_ZIP}`);
        exec(`rm -rf ${TMP_DIR} && mkdir -p ${TMP_DIR}`);
        exec(`unzip -o ${TMP_ZIP} -d ${TMP_DIR}`);
        const files = fs.readdirSync(TMP_DIR).filter((f) => f.endsWith(".json"));
        if (files.length > 0) {
          artifactData = JSON.parse(fs.readFileSync(path.join(TMP_DIR, files[0]), "utf8"));
        }
        pingerResults.push({
          label: pinger.label,
          tested: true,
          data_url: pinger.data_url,
          run_id: recentRunId,
          files_verified: files.length,
          filename: files[0] ?? null,
        });
      } catch (e) {
        results.push(fail(`recent_artifact_exists_${pinger.label}`, `artifact download failed — ${e.message}`));
        pingerResults.push({ label: pinger.label, tested: false, reason: `artifact download failed — ${e.message}` });
      }
    } else {
      // no data_url — not publicly verifiable
      results.push({ id: `pinger_out_of_scope_${pinger.label}`, status: "skipped", reason: `no data_url — results not publicly accessible` });
      pingerResults.push({ label: pinger.label, tested: false, reason: "no data_url — results not publicly accessible" });
    }
  }

  return { results, artifactData, pingerResults };
}

// --- level 4 — output integrity structure -----------------------------------

function checkStructure(data) {
  if (!data) return [
    "artifact_valid_json", "artifact_required_fields",
    "artifact_benchmark_value", "artifact_all_providers"
  ].map((id) => fail(id, "skipped — artifact not available"));

  const results = [];

  results.push(pass("artifact_valid_json")); // already parsed

  const required = CONTRACT.levels[3].required_fields;
  const missing = required.filter((f) => data[f] === undefined || data[f] === null || (f === "timeout_ms" && typeof data[f] !== "number"));
  results.push(missing.length === 0
    ? pass("artifact_required_fields")
    : fail("artifact_required_fields", `missing fields: ${missing.join(", ")}`));

  results.push(data.benchmark === CONTRACT.levels[3].expected_benchmark_value
    ? pass("artifact_benchmark_value")
    : fail("artifact_benchmark_value", `expected "tools/list", got "${data.benchmark}"`));

  const expected = CONTRACT.levels[3].expected_providers;
  const found = (data.results || []).map((r) => r.name);
  const missing_providers = expected.filter((p) => !found.includes(p));
  results.push(missing_providers.length === 0
    ? pass("artifact_all_providers")
    : fail("artifact_all_providers", `missing providers: ${missing_providers.join(", ")}`));

  return results;
}

// --- level 5 — output integrity content -------------------------------------

function checkContent(data) {
  if (!data?.results) return CONTRACT.levels[4].checks
    .map((c) => fail(c.id, "skipped — artifact not available"));

  const results = data.results;
  const okResults = results.filter((r) => r.ok === true);

  // artifact_run_metadata
  const jitter = data.jitter_ms;
  const checks = [];
  checks.push(typeof jitter === "number" && jitter >= 0
    ? pass("artifact_run_metadata")
    : fail("artifact_run_metadata", `jitter_ms invalid: ${jitter}`));

  // artifact_result_fields
  const badFields = results.filter((r) => !r.url || (typeof r.http_status !== "number" && !(r.ok === false && r.http_status === null)));
  checks.push(badFields.length === 0
    ? pass("artifact_result_fields")
    : fail("artifact_result_fields", `${badFields.length} result(s) missing url or http_status`));

  // artifact_result_ok_field
  const badOk = results.filter((r) => typeof r.ok !== "boolean");
  checks.push(badOk.length === 0
    ? pass("artifact_result_ok_field")
    : fail("artifact_result_ok_field", `${badOk.length} result(s) have missing or non-boolean ok field — providers: ${badOk.map((r) => r.name).join(", ")}`));

  // artifact_mcpclient_identity
  const badIdentity = results.filter((r) => {
    const c = getMcpClient(r);
    return !c || !c.hostname || !c.platform || !c.node_version;
  });
  checks.push(badIdentity.length === 0
    ? pass("artifact_mcpclient_identity")
    : fail("artifact_mcpclient_identity", `${badIdentity.length} result(s) missing hostname/platform/node_version`));

  // artifact_mcpclient_ipv4
  const badIpv4 = results.filter((r) => getMcpClient(r)?.ipv4 == null);
  checks.push(badIpv4.length === 0
    ? pass("artifact_mcpclient_ipv4")
    : fail("artifact_mcpclient_ipv4", `${badIpv4.length} result(s) have null ipv4 — providers: ${badIpv4.map((r) => r.name).join(", ")}`));

  // artifact_mcpclient_geo
  const badClientGeo = results.filter((r) => {
    const geo = getMcpClient(r)?.geo;
    return !geo || !geo.city || !geo.country_code || geo.latitude == null || geo.longitude == null;
  });
  checks.push(badClientGeo.length === 0
    ? pass("artifact_mcpclient_geo")
    : fail("artifact_mcpclient_geo", `${badClientGeo.length} result(s) missing mcpclient geo fields`));

  // artifact_mcpclient_latencies
  const badClientLatency = results.filter((r) => {
    const t = r.timestamps?.mcpclient;
    return !t || !isPositiveNumber(t.request_start_ms) || !isPositiveNumber(t.request_end_ms);
  });
  checks.push(badClientLatency.length === 0
    ? pass("artifact_mcpclient_latencies")
    : fail("artifact_mcpclient_latencies", `${badClientLatency.length} result(s) missing or invalid mcpclient timestamps`));

  // artifact_mcpserver_identity
  const badServerIdentity = okResults.filter((r) => !getMcpServer(r)?.provider);
  checks.push(badServerIdentity.length === 0
    ? pass("artifact_mcpserver_identity")
    : fail("artifact_mcpserver_identity", `${badServerIdentity.length} ok result(s) missing mcpserver provider`));

  // artifact_mcpserver_resolved_ip
  const badResolvedIp = okResults.filter((r) => getMcpServer(r)?.resolved_ip == null);
  checks.push(badResolvedIp.length === 0
    ? pass("artifact_mcpserver_resolved_ip")
    : fail("artifact_mcpserver_resolved_ip", `${badResolvedIp.length} ok result(s) have null resolved_ip — providers: ${badResolvedIp.map((r) => r.name).join(", ")}`));

  // artifact_mcpserver_geo
  const badServerGeo = okResults.filter((r) => {
    const geo = getMcpServer(r)?.geo;
    return !geo || !geo.city || !geo.country_code || geo.latitude == null || geo.longitude == null;
  });
  checks.push(badServerGeo.length === 0
    ? pass("artifact_mcpserver_geo")
    : fail("artifact_mcpserver_geo", `${badServerGeo.length} ok result(s) missing mcpserver geo fields`));

  // artifact_mcpserver_latencies
  const badServerLatency = okResults.filter((r) => {
    const t = r.timestamps?.mcpserver;
    return !t || !isPositiveNumber(t.start_ms) || !isPositiveNumber(t.end_ms);
  });
  checks.push(badServerLatency.length === 0
    ? pass("artifact_mcpserver_latencies")
    : fail("artifact_mcpserver_latencies", `${badServerLatency.length} ok result(s) missing or invalid mcpserver timestamps`));

  // artifact_tools_present
  const badTools = okResults.filter((r) => !Array.isArray(r.tools) || r.tools.length === 0);
  checks.push(badTools.length === 0
    ? pass("artifact_tools_present")
    : fail("artifact_tools_present", `${badTools.length} ok result(s) have missing or empty tools array`));

  return checks;
}

// --- push report to data branch ---------------------------------------------

function pushReport(report) {
  try { exec("git fetch origin data:data", { stdio: "pipe" }); } catch {}

  const dataExists = exec("git branch --list data").trim() !== "";
  if (fs.existsSync(WORKTREE_DIR)) exec(`git worktree remove --force ${WORKTREE_DIR}`);

  if (dataExists) {
    exec(`git worktree add ${WORKTREE_DIR} data`);
  } else {
    const emptyTree = exec("git hash-object -t tree /dev/null").trim();
    const emptyCommit = exec(`git commit-tree ${emptyTree} -m "init: data branch"`).trim();
    exec(`git branch data ${emptyCommit}`);
    exec(`git worktree add ${WORKTREE_DIR} data`);
  }

  const filename = `verify_report_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(WORKTREE_DIR, filename), JSON.stringify(report, null, 2));
  exec(`git -C ${WORKTREE_DIR} add '*.json'`);
  exec(`git -C ${WORKTREE_DIR} commit -m "verify: ${report.summary.pass}/${report.summary.total} checks passed"`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      exec(`git -C ${WORKTREE_DIR} push origin data`);
      break;
    } catch {
      if (attempt < 3) exec(`git -C ${WORKTREE_DIR} pull --rebase origin data`);
    }
  }

  exec(`git worktree remove --force ${WORKTREE_DIR}`);
  return filename;
}

// --- main -------------------------------------------------------------------

const startedAt = Date.now();
const discoverability = checkDiscoverability();
const completeness = checkCompleteness();
const pingers = loadPingers();

let availability = [];
let artifactData = null;
let pingerResults = [];

if (LOCAL_FILE) {
  console.log(`\n[verify] --local-file mode: skipping level 3, reading ${LOCAL_FILE}`);
  try {
    artifactData = JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8"));
  } catch (e) {
    availability = [{ id: "local_file_read", status: "fail", reason: `could not read local file: ${e.message}` }];
  }
} else {
  ({ results: availability, artifactData, pingerResults } = checkAvailability(pingers));
}

const structure = checkStructure(artifactData);
const content = checkContent(artifactData);

const allChecks = [
  ...discoverability,
  ...completeness,
  ...availability.filter((c) => c.status !== "skipped"),
  ...structure,
  ...content,
];

const summary = {
  pass: allChecks.filter((c) => c.status === "pass").length,
  fail: allChecks.filter((c) => c.status === "fail").length,
  total: allChecks.length,
};

const report = {
  component: CONTRACT.component,
  verified_at: new Date().toISOString(),
  duration_ms: Date.now() - startedAt,
  pingers_tested: pingerResults.filter((p) => p.tested).map((p) => ({
    label: p.label,
    run_id: p.run_id,
    files_verified: p.files_verified,
    filename: p.filename,
  })),
  pingers_out_of_scope: pingerResults.filter((p) => !p.tested).map((p) => ({ label: p.label, reason: p.reason })),
  summary,
  checks: allChecks,
};

console.log(`\n[verify] ${CONTRACT.component}`);
console.log(`[verify] ${summary.pass}/${summary.total} passed, ${summary.fail} failed\n`);
for (const c of allChecks) {
  const icon = c.status === "pass" ? "✓" : "✗";
  const detail = c.reason ? ` — ${c.reason}` : "";
  console.log(`  ${icon} ${c.id}${detail}`);
}

if (LOCAL_FILE) {
  console.log(`\n[verify] --local-file mode: report not pushed`);
} else {
  const filename = pushReport(report);
  console.log(`\n[verify] report pushed → data/${filename}`);
}

process.exit(summary.fail > 0 ? 1 : 0);
