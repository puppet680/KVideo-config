const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 路径配置 ===
const CONFIG_PATH = path.join(__dirname, "KVideo-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";

// === 参数配置 ===
const MAX_DAYS = 30;
const WARN_STREAK = 3; // 连续失败 3 次显示 🚨
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 10; 

// 1. 加载并检查配置
if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ 找不到配置文件:", CONFIG_PATH);
    process.exit(1);
}

const configArray = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// 2. 映射字段 (适配数组格式: baseUrl, enabled)
const apiEntries = configArray.map((s) => ({
    name: s.name,
    api: s.baseUrl, 
    id: s.id || "-",
    disabled: s.enabled === false,
}));

// 3. 读取历史记录 (从 report.md 提取)
let history = [];
if (fs.existsSync(REPORT_PATH)) {
    const oldContent = fs.readFileSync(REPORT_PATH, "utf-8");
    const match = oldContent.match(/```json\n([\s\S]+?)\n```/);
    if (match) {
        try { history = JSON.parse(match[1]); } catch (e) { history = []; }
    }
}

// 4. 并发控制函数
const queueRun = async (tasks, limit) => {
    const results = [];
    const executing = new Set();
    for (const [i, task] of tasks.entries()) {
        const p = task().then(res => results[i] = res);
        executing.add(p);
        p.finally(() => executing.delete(p));
        if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
    return results;
};

// 5. 主逻辑
(async () => {
    console.log(`⏳ 开始检测 ${apiEntries.length} 个源...`);

    const tasks = apiEntries.map(s => async () => {
        if (s.disabled) return { api: s.api, success: false, search: "已禁用" };
        try {
            // 测试基础连接
            const res = await axios.get(s.api, { timeout: TIMEOUT_MS });
            const ok = res.status === 200;
            
            // 测试搜索功能
            let searchResult = "-";
            if (ok) {
                const sRes = await axios.get(`${s.api}?wd=${encodeURIComponent(SEARCH_KEYWORD)}`, { timeout: TIMEOUT_MS });
                searchResult = (sRes.data && sRes.data.list && sRes.data.list.length > 0) ? "✅" : "无结果";
            }
            return { api: s.api, success: ok, search: searchResult };
        } catch (e) {
            return { api: s.api, success: false, search: "❌" };
        }
    });

    const todayResults = await queueRun(tasks, CONCURRENT_LIMIT);
    
    // 保存历史
    history.push({ date: new Date().toISOString().split('T')[0], results: todayResults });
    if (history.length > MAX_DAYS) history.shift();

    // 生成表格内容
    let tableRows = "";
    apiEntries.forEach(s => {
        const latest = todayResults.find(r => r.api === s.api);
        
        // 计算连跪次数 (Streak)
        let streak = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            const r = history[i].results.find(x => x.api === s.api);
            if (r && r.success) break;
            streak++;
        }

        let status = "✅";
        if (s.disabled) status = "🚫";
        else if (streak >= WARN_STREAK) status = "🚨";
        else if (!latest || !latest.success) status = "❌";

        tableRows += `| ${status} | ${s.name} | ${s.id} | [接口](${s.api}) | ${latest?.search || "-"} | ${streak} |\n`;
    });

    const now = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16) + " CST";
    const reportMd = `# 接口检测报告\n\n更新时间: ${now}\n\n| 状态 | 名称 | ID | 链接 | 搜索测试 | 连跪次数 |\n|---|---|---|---|---|---|\n${tableRows}\n\n<details><summary>历史数据 (JSON)</summary>\n\n\`\`\`json\n${JSON.stringify(history, null, 2)}\n\`\`\`\n</details>`;

    fs.writeFileSync(REPORT_PATH, reportMd);
    console.log("✅ 检测完成，报告已更新。");
})();
