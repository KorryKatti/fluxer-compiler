const BASE_URL = "https://godbolt.org/api"
const USER_AGENT = "fluxer-compiler-bot/1.0"

// global cap on simultaneous godbolt requests (FIFO): extra callers
// wait their turn instead of bursting godbolt. The 20s fetch timeout
// starts only once a slot is acquired, not while queued.
export const MAX_IN_FLIGHT =
	Number.isFinite(Number(process.env.MAX_IN_FLIGHT)) &&
	Number(process.env.MAX_IN_FLIGHT) > 0
		? Number(process.env.MAX_IN_FLIGHT)
		: 5;

let inFlight = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
	if (inFlight < MAX_IN_FLIGHT) {
		inFlight++;
		return;
	}
	// woken by release(), which hands its slot directly to us,
	// so inFlight is intentionally not incremented here
	await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
	const next = waiters.shift();
	if (next) {
		next(); // slot transfers to the next waiter, inFlight unchanged
	} else {
		inFlight--;
	}
}

// global "phone line busy" cap: token bucket across all users,
// ~GLOBAL_RATE_PER_MIN requests/minute sustained (default 30 = 1 per 2s),
export const GLOBAL_RATE_PER_MIN =
	Number.isFinite(Number(process.env.GLOBAL_RATE_PER_MIN)) &&
	Number(process.env.GLOBAL_RATE_PER_MIN) > 0
		? Number(process.env.GLOBAL_RATE_PER_MIN)
		: 30;
const REFILL_MS = 60_000 / GLOBAL_RATE_PER_MIN;
let tokens = MAX_IN_FLIGHT;
let lastRefill = Date.now();

function refill(now: number): void {
	const elapsed = now - lastRefill;
	if (elapsed <= 0) return;
	tokens = Math.min(MAX_IN_FLIGHT, tokens + elapsed / REFILL_MS);
	lastRefill = now;
}

/** ms until a global slot is free, 0 if one is available now. Does not consume. */
export function globalLimitWaitMs(now = Date.now()): number {
	refill(now);
	return tokens >= 1 ? 0 : Math.ceil((1 - tokens) * REFILL_MS);
}

/** Spend one global token if available. Synchronous, so no race between peek and spend. */
export function consumeGlobalLimit(now = Date.now()): boolean {
	if (globalLimitWaitMs(now) > 0) return false;
	tokens--;
	return true;
}

// verified against https://godbolt.org/api/compilers (2026)
export const languages: Record<string, string> = {
  cpp: "g132", // x86-64 gcc 13.2 (c++)
  c: "cg132", // x86-64 gcc 13.2 (c)
  python: "python312", // Python 3.12
  go: "gl12212", // x86-64 gc 1.22.12
  javascript: "v8113", // v8 11.3 (godbolt has no Node.js)
  zig: "z0140", // zig 0.14.0
  lua: "lua550", // Lua 5.5.0
  haskell: "ghc9122", // x86-64 ghc 9.12.2
  asm: "gnuas151", // x86-64 binutils 2.45 (GNU assembler)
};

export interface Output{
	ok:boolean;
	stdout:string;
	stderr:string;
	code:number; // -1 on our own failure or exit code
	err:string; // our error
}

// output with no content
function blank(): Output {
	return {ok:false,stdout:"",stderr:"",code:-1,err:""};
}

function emptyOutput(err:string):Output{
	const o = blank();
	o.err = err;
	return o
}

// body being sent
interface GodboltReq{
	source:string;
	options:{
		userArguments:string;
		filters:{
			execute:boolean;
			intel:boolean;
			directives:boolean;
			labels:boolean;
			commentOnly:boolean;
			trim:boolean;
		};
	};
}

// line of stdout/stderr array.
interface TextLine {
	text:string;
}

interface BuildResult{
	code:number;
	stderr:TextLine[];
}

// execution requested and compiler ran it
interface ExecResult {
	code:number;
	stdout:TextLine[];
	stderr:TextLine[];
	didExecute:boolean;
	buildResult?:BuildResult;
}

// my nvim doesnt even have .ts configured i am just rawdogging it

interface GodboltResp{
	code:number;
	stdout:TextLine[];
	stderr:TextLine[];
	// assembly output, only present when execute is false
	asm?:TextLine[];
	execResult?:ExecResult;
}

function joinText(lines:TextLine[]|undefined):string {
	if (!lines) return "";
	// godbolt lines carry no trailing newline, so join them explicitly;
	// also strip ANSI colour codes from compiler diagnostics
	return lines
		.map((l) => l.text)
		.join("\n")
		.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

// post to godbolt and return parsed body or error
// good night

async function makeRequest(
	compilerId:string,
	// good morning
	body:GodboltReq,
): Promise<{resp:GodboltResp | null;err:string}>{
	const url = `${BASE_URL}/compiler/${compilerId}/compile`;
	await acquire();
	try {
		// timeout starts here, after acquiring a slot, not while queued
		const res = await fetch (url,{
			method:"POST",
			headers:{
				"Content-Type":"application/json",
				Accept:"application/json",
				"User-Agent": USER_AGENT,
			},
			body:JSON.stringify(body),
			signal:AbortSignal.timeout(20_000),
		});
		if (!res.ok){
			return {resp:null,err:`godbolt returned ${res.status}`};
		}
		try {
			const resp = (await res.json()) as GodboltResp;
			return {resp,err:""};
		} catch (e){
			return {resp:null,err:`invalid response: ${String(e)}`};
		}
	} catch (e){
		return { resp:null,err:`request failed: ${String(e)}`};
	} finally {
		release();
	}
}

function baseBody(source:string,execute:boolean):GodboltReq{
	return {
		source:source,
		options:{
			userArguments:"",
			filters:{
				execute:execute,
				intel:false,
				directives:true,
				labels:true,
				commentOnly:true,
				trim:false,
			},
		},
	};
}

// compiles and runs
export async function runCode(lang:string,source:string):Promise<Output>{
	const id = languages[lang];
	if (!id){
		return emptyOutput(`unknown language: ${lang}`);
	}
	const {resp,err}=await makeRequest(id,baseBody(source,true));
	if (err){
		return emptyOutput(err);
	}
	if (!resp){
		return emptyOutput("no response");
	}
	const o = blank();

	// execResult holds run step
	const exec = resp.execResult;
	if (!exec){
		o.stdout=joinText(resp.stdout);
		o.stderr=joinText(resp.stderr);
		o.code=resp.code;
		if (resp.code===0){
			o.err="no execResult (compiler may not support execution)";
		}
		return o;
	}

	if (!exec.didExecute){
		o.stderr = joinText(exec.buildResult?.stderr??exec.stderr);
		o.code = exec.buildResult?.code ?? -1;
		return o;
	}

	o.ok = true;
	o.stdout = joinText(exec.stdout);
	o.stderr = joinText(exec.stderr);
	o.code = exec.code;
	return o;
}

// only compiles
export async function compileCode(
	lang:string,
	source:string,
):Promise<Output>{
	const id = languages[lang];
	if (!id){
		return emptyOutput(`unknown language: ${lang}`);
	}

	const {resp,err} = await makeRequest(id,baseBody(source,false));
	if (err){
		return emptyOutput(err);
	}
	if (!resp){
		return emptyOutput("no response");
	}

	const o = blank();
	o.ok = true;
	// assembly lives in `asm`, not stdout, when not executing
	if (resp.code===0) o.stdout= joinText(resp.asm);
	o.stderr= joinText(resp.stderr);
	o.code = resp.code;
	return o;
}
