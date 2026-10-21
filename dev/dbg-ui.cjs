/**
 * dev/dbg-ui.cjs — 调试助手：把 Panel 的虚拟树结构打出来。
 *
 * 什么时候用：render-check.cjs 报"某某文案找不到"时，先跑这个看树到底渲染成了什么形状
 * （踩过的两个坑：children 没放进 props.children、vm 跨 realm 导致遍历器静默停住）。
 *
 * 用法：node dev/dbg-ui.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

let hookIndex = 0;
const hookStates = [];
const ReactStub = {
	createElement(type, props, ...children) {
		return { type, props: props || {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) };
	},
	useState(initial) {
		const i = hookIndex++;
		if (!(i in hookStates)) hookStates[i] = typeof initial === "function" ? initial() : initial;
		return [hookStates[i], (n) => { hookStates[i] = typeof n === "function" ? n(hookStates[i]) : n; }];
	},
	useEffect() {},
	useMemo(fn) { return fn(); },
	useRef(v) { const i = hookIndex++; if (!(i in hookStates)) hookStates[i] = { current: v }; return hookStates[i]; },
};

let exported = null;
const win = { __ModuleLoader__: { load(spec) { exported = spec.factory((n) => (n === "react" ? ReactStub : {})); } } };
const doc = { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {}, style: {} }), addEventListener() {}, removeEventListener() {} };
const src = fs.readFileSync(path.join(__dirname, "..", "client.js"), "utf8");
new Function("window", "document", "fetch", "setTimeout", "clearTimeout", "console", src)(win, doc, async () => ({ ok: true, json: async () => ({}) }), () => 0, () => {}, console);

const T = exported.__test;
T.store.data = { entries: [], hostCore: { calls: 0, tools: [] }, totals: {}, tags: { all: [] }, stats: {}, job: {}, weeklyDue: {}, reports: {}, dataDir: "x" };
T.store.loading = false;
T.store.error = null;
T.store.open = null;
T.store.plan = null;
T.store.query = ""; T.store.source = "any"; T.store.kind = "all"; T.store.sort = "calls";

hookIndex = 0;
const tree = T.Panel({});
console.log("tree type:", typeof tree, "isArray:", Array.isArray(tree));
console.log("keys:", Object.keys(tree || {}));
if (tree && tree.props) {
	console.log("className:", tree.props.className);
	console.log("children count:", Array.isArray(tree.props.children) ? tree.props.children.length : typeof tree.props.children);
	const kids = tree.props.children;
	if (Array.isArray(kids)) {
		for (const kid of kids.slice(0, 6)) {
			console.log("  kid:", kid && typeof kid === "object" ? kid.type + " " + JSON.stringify(kid.props && kid.props.className) : String(kid).slice(0, 40));
		}
	}
}
