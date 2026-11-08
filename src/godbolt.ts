const BASE = "https://godbolt.org/api"
const UA = "fluxer-compiler-bot/1.0"

// will verify and fill later
export const languages: Record<string, string> = {
  cpp: "g132",
  c: "cg132",
  python: "python312",
  go: "gl1220",
  javascript: "nodejs2011",
  zig: "zig0170",
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
	execResult?:ExecResult;
}

function joinText(lines:TextLine[]|undefined):string {
	if (!lines) return "";
	let out = "";
	// switched to vscode
	for (const l of lines){
		out+=l.text;
	}
	return out;
}

// post to godbolt and return parsed body or error
// good night

async function makeRequest(
	compilerId:string,
	// good morning
	body:GodboltReq,
): Promise<{resp:GodboltResp | null;err:string}>{
	const url = `${BASE_URL}/compiler/${compilerId}/compile`;
	let res: Response;
	try {
		res = await fetch (url,{
			method:"POST",
			headers:{
				"Content-Type":"application/json",
				Accept:"application/json",
				"User-Agent": USER_AGENT,
			},
			body:JSON.stringify(body),
			signal:AbortSignal.timeout(20_000),
		});
	} catch (e){
		return { resp:null,err:`request failed: ${String(e)}`};
	}
	if (!res.ok){
		return {resp:null,err:`godbolt returned ${res.status}`};
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
		o.err="no execResult (compiler may not support execution)";
		o.stderr=joinText(resp.stderr);
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
	o.stderr= joinText(resp.stderr);
	o.code = resp.code;
	return o;
}
