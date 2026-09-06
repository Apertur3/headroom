/**
 * `headroom completion <bash|zsh|fish|pwsh>`: prints a completion script for
 * the given shell, generated from the same COMMAND_LIST / COMMAND_HELP table
 * `--help` already reads (see cli.ts) -- a new command or flag only has to
 * be added once, in that table, to show up here too.
 *
 * Two hidden helpers back the dynamic parts of the bash and zsh scripts:
 * `_complete-meters` and `_complete-principals`. Each is a one-id-per-line,
 * best-effort read (the daemon if it answers fast, the local store
 * otherwise) bounded to a fixed deadline -- past that, or on any failure, it
 * prints nothing and still exits 0. A completion script runs on every Tab
 * press; it must never hang or error a user's shell.
 */
import { COMMAND_HELP, COMMAND_LIST } from "./cli.js";
import { daemonRequest, socketPath } from "./daemon.js";
import { readAccounts } from "./registry.js";
import { HeadroomStore } from "./store.js";

export type Shell = "bash" | "zsh" | "fish" | "pwsh";
export const SHELLS: readonly Shell[] = ["bash", "zsh", "fish", "pwsh"];

export const COMPLETION_HELP = "Usage: headroom completion <bash|zsh|fish|pwsh>";

export interface CommandSpec {
  readonly name: string;
  readonly subcommands: readonly string[];
  readonly flags: readonly string[];
}

const FLAG_PATTERN = /--[a-z][a-z0-9-]*/g;

function flagsFromText(text: string): string[] {
  return [...new Set(text.match(FLAG_PATTERN) ?? [])].sort();
}

/** Picks a literal subcommand alternation out of a COMMAND_LIST name, e.g.
 * "lease start|list|end" -> ["start","list","end"], "accounts discover" ->
 * ["discover"]. A placeholder argument like "history <meter>" or
 * "cost [<action-class>]" never matches -- those are values, not
 * subcommands. */
function subcommandsFromListName(name: string): string[] {
  const rest = name.split(/\s+/).slice(1).join(" ");
  const alternation = /^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.exec(rest);
  return alternation ? rest.split("|") : [];
}

/** inbox's `send` and plan's `import` are named only inside their own usage
 * text (COMMAND_HELP), not in their COMMAND_LIST name -- picked out here
 * instead of a second hardcoded command table. */
const EXTRA_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  inbox: ["send"],
  plan: ["import"],
};

/** Built fresh from cli.ts's own COMMAND_LIST/COMMAND_HELP on every call:
 * every top-level command, its known subcommands, and the full set of flags
 * its usage text mentions (its own COMMAND_HELP entry if it has one; the
 * --help summary line otherwise, e.g. `status`, which has no usage string of
 * its own). Nothing here is a second copy of the command table -- it is
 * parsed out of the one cli.ts already maintains. */
export function commandSpecs(): CommandSpec[] {
  const byName = new Map<string, { name: string; subcommands: string[] }>();
  for (const [rawName] of COMMAND_LIST) {
    const name = rawName.split(/\s+/)[0];
    const entry = byName.get(name) ?? { name, subcommands: [] };
    for (const sub of subcommandsFromListName(rawName)) if (!entry.subcommands.includes(sub)) entry.subcommands.push(sub);
    byName.set(name, entry);
  }
  for (const [name, extra] of Object.entries(EXTRA_SUBCOMMANDS)) {
    const entry = byName.get(name);
    if (!entry) continue;
    for (const sub of extra) if (!entry.subcommands.includes(sub)) entry.subcommands.push(sub);
  }
  // "completion" itself: its only "subcommand" is the shell name, a value
  // this file already owns the list of (SHELLS), not a second copy of
  // anything cli.ts maintains.
  const completionEntry = byName.get("completion");
  if (completionEntry) completionEntry.subcommands = [...SHELLS];
  const summaries = new Map(COMMAND_LIST.map(([rawName, summary]) => [rawName.split(/\s+/)[0], summary]));
  return [...byName.values()]
    .map((entry) => ({
      name: entry.name,
      subcommands: entry.subcommands,
      flags: flagsFromText(COMMAND_HELP[entry.name] ?? summaries.get(entry.name) ?? ""),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bashCaseArm(spec: CommandSpec): string {
  const flags = spec.flags.join(" ");
  if (!spec.subcommands.length) {
    return [`    ${spec.name})`, `      COMPREPLY=( $(compgen -W "${flags}" -- "$cur") )`, "      ;;"].join("\n");
  }
  const withSubs = [...spec.subcommands, ...spec.flags].join(" ");
  return [
    `    ${spec.name})`,
    "      if [[ $COMP_CWORD -eq 2 ]]; then",
    `        COMPREPLY=( $(compgen -W "${withSubs}" -- "$cur") )`,
    "      else",
    `        COMPREPLY=( $(compgen -W "${flags}" -- "$cur") )`,
    "      fi",
    "      ;;",
  ].join("\n");
}

export function generateBashScript(specs: CommandSpec[] = commandSpecs()): string {
  const commands = specs.map((spec) => spec.name).join(" ");
  const cases = specs.map(bashCaseArm).join("\n");
  return [
    "# headroom bash completion",
    '# Add to your shell profile: eval "$(headroom completion bash)"',
    "_headroom_complete() {",
    "  local cur prev cmd",
    "  COMPREPLY=()",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '  cmd="${COMP_WORDS[1]}"',
    "",
    '  if [[ "$prev" == "--meter" ]]; then',
    '    COMPREPLY=( $(compgen -W "$(headroom _complete-meters 2>/dev/null)" -- "$cur") )',
    "    return 0",
    "  fi",
    '  if [[ "$prev" == "--principal" ]]; then',
    '    COMPREPLY=( $(compgen -W "$(headroom _complete-principals 2>/dev/null)" -- "$cur") )',
    "    return 0",
    "  fi",
    "",
    "  if [[ $COMP_CWORD -eq 1 ]]; then",
    `    COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )`,
    "    return 0",
    "  fi",
    "",
    '  case "$cmd" in',
    cases,
    "    *)",
    "      COMPREPLY=()",
    "      ;;",
    "  esac",
    "}",
    "complete -F _headroom_complete headroom",
    "",
  ].join("\n");
}

function zshCaseArm(spec: CommandSpec): string {
  const flags = spec.flags.join(" ");
  if (!spec.subcommands.length) {
    return [`    ${spec.name})`, `      compadd -- ${flags}`, "      ;;"].join("\n");
  }
  const withSubs = [...spec.subcommands, ...spec.flags].join(" ");
  return [
    `    ${spec.name})`,
    "      if (( CURRENT == 3 )); then",
    `        compadd -- ${withSubs}`,
    "      else",
    `        compadd -- ${flags}`,
    "      fi",
    "      ;;",
  ].join("\n");
}

export function generateZshScript(specs: CommandSpec[] = commandSpecs()): string {
  const commands = specs.map((spec) => spec.name).join(" ");
  const cases = specs.map(zshCaseArm).join("\n");
  return [
    "#compdef headroom",
    '# Add to your shell profile: eval "$(headroom completion zsh)"',
    "_headroom() {",
    "  local cur prev cmd",
    '  cur="${words[CURRENT]}"',
    '  prev="${words[CURRENT-1]}"',
    '  cmd="${words[2]}"',
    "",
    '  if [[ "$prev" == "--meter" ]]; then',
    "    compadd -- $(headroom _complete-meters 2>/dev/null)",
    "    return 0",
    "  fi",
    '  if [[ "$prev" == "--principal" ]]; then',
    "    compadd -- $(headroom _complete-principals 2>/dev/null)",
    "    return 0",
    "  fi",
    "",
    "  if (( CURRENT == 2 )); then",
    `    compadd -- ${commands}`,
    "    return 0",
    "  fi",
    "",
    '  case "$cmd" in',
    cases,
    "  esac",
    "}",
    "",
    '_headroom "$@"',
    "",
  ].join("\n");
}

export function generateFishScript(specs: CommandSpec[] = commandSpecs()): string {
  const lines: string[] = [
    "# headroom fish completion",
    "# Add to your shell profile: headroom completion fish | source",
    "function __headroom_commands",
  ];
  for (const spec of specs) lines.push(`    echo ${spec.name}`);
  lines.push("end", "", "complete -c headroom -f", 'complete -c headroom -n "__fish_use_subcommand" -a "(__headroom_commands)"');
  for (const spec of specs) {
    if (spec.subcommands.length) lines.push(`complete -c headroom -n "__fish_seen_subcommand_from ${spec.name}" -a "${spec.subcommands.join(" ")}"`);
    for (const flag of spec.flags) lines.push(`complete -c headroom -n "__fish_seen_subcommand_from ${spec.name}" -l ${flag.replace(/^--/, "")}`);
  }
  return lines.join("\n") + "\n";
}

export function generatePwshScript(specs: CommandSpec[] = commandSpecs()): string {
  const commandList = specs.map((spec) => `'${spec.name}'`).join(",");
  const commandMap = specs
    .map((spec) => {
      const subs = spec.subcommands.map((sub) => `'${sub}'`).join(",");
      const flags = spec.flags.map((flag) => `'${flag}'`).join(",");
      return `    '${spec.name}' = @{ Subcommands = @(${subs}); Flags = @(${flags}) }`;
    })
    .join("\n");
  return [
    "# headroom PowerShell completion",
    "# Add to your profile: Invoke-Expression (headroom completion pwsh | Out-String)",
    "$headroomCommandMap = @{",
    commandMap,
    "}",
    "",
    "Register-ArgumentCompleter -Native -CommandName headroom -ScriptBlock {",
    "    param($wordToComplete, $commandAst, $cursorPosition)",
    "    $tokens = $commandAst.CommandElements | ForEach-Object { $_.Extent.Text }",
    "    $words = @($tokens) + @($wordToComplete)",
    "    $candidates = @()",
    "    if ($words.Count -le 2) {",
    `        $candidates = @(${commandList})`,
    "    } elseif ($headroomCommandMap.ContainsKey($words[1])) {",
    "        $spec = $headroomCommandMap[$words[1]]",
    "        if ($words.Count -eq 3) { $candidates = $spec.Subcommands + $spec.Flags }",
    "        else { $candidates = $spec.Flags }",
    "    }",
    '    $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
    "        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
    "    }",
    "}",
    "",
  ].join("\n");
}

export function generateCompletionScript(shell: Shell, specs: CommandSpec[] = commandSpecs()): string {
  if (shell === "bash") return generateBashScript(specs);
  if (shell === "zsh") return generateZshScript(specs);
  if (shell === "fish") return generateFishScript(specs);
  return generatePwshScript(specs);
}

function isShell(value: string | undefined): value is Shell {
  return value !== undefined && (SHELLS as readonly string[]).includes(value);
}

export async function completionCommand(argv: string[]): Promise<number> {
  if (argv.length !== 1 || !isShell(argv[0])) throw new Error(COMPLETION_HELP);
  console.log(generateCompletionScript(argv[0]));
  return 0;
}

/** Runs `work`, but resolves to `undefined` the moment `ms` elapses even if
 * `work` is still pending -- the caller (a completion helper) must return in
 * time for a shell's completion timeout regardless of how a slow daemon or a
 * locked store file behaves. */
function withDeadline<T>(work: () => Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), ms);
    work().then(finish).catch(() => finish(undefined));
  });
}

/** A genuine JSON-RPC error reply is the full envelope (`{jsonrpc, id,
 * error}`) -- unusable as completion data, and never worth surfacing to a
 * shell's completion pop-up. */
function isRpcError(value: unknown): boolean {
  return !!value && typeof value === "object" && "jsonrpc" in value && "error" in value;
}

const COMPLETION_DEADLINE_MS = 200;

async function idsFromDaemonOrElse<T>(field: "meter_id" | "principal_id", fallback: () => Promise<string[]>): Promise<string[]> {
  const request = await daemonRequest(socketPath(), "status", {}, 150);
  if (request.status === "available" && !isRpcError(request.result)) {
    return [...new Set((request.result as Record<string, unknown>[]).map((item) => String(item[field])))];
  }
  return fallback();
}

/** Every meter id `headroom` currently knows about, for `--meter` completion:
 * the daemon's own live status if it answers within budget, the local store
 * otherwise. Bounded to COMPLETION_DEADLINE_MS total; empty on any failure or
 * timeout rather than ever throwing or hanging a shell's Tab key. */
export async function completionMeterIds(deadlineMs = COMPLETION_DEADLINE_MS): Promise<string[]> {
  const ids = await withDeadline(
    () =>
      idsFromDaemonOrElse("meter_id", async () => {
        const store = await HeadroomStore.open();
        try { return [...new Set(store.latestPerWindow().map((item) => item.meter_id))]; }
        finally { store.close(); }
      }),
    deadlineMs,
  );
  return ids ?? [];
}

/** Every configured principal id, for `--principal` completion: the daemon's
 * own live status if it answers within budget, the account registry
 * otherwise. Same bound and same silent-empty failure mode as
 * completionMeterIds. */
export async function completionPrincipalIds(deadlineMs = COMPLETION_DEADLINE_MS): Promise<string[]> {
  const ids = await withDeadline(
    () =>
      idsFromDaemonOrElse("principal_id", async () => {
        const accounts = await readAccounts();
        return [...new Set(accounts.map((item) => item.name))];
      }),
    deadlineMs,
  );
  return ids ?? [];
}

export async function printCompletionMeterIds(): Promise<number> {
  for (const id of await completionMeterIds()) console.log(id);
  return 0;
}

export async function printCompletionPrincipalIds(): Promise<number> {
  for (const id of await completionPrincipalIds()) console.log(id);
  return 0;
}
