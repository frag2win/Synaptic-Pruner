const { execSync } = require('child_process');
const fs = require('fs');

let log = "";
function run(cmd) {
    log += `user@host:~/project$ ${cmd}\n`;
    try {
        const out = execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' });
        if (out) log += out + "\n";
    } catch(e) {
        if (e.stdout) log += e.stdout + "\n";
        if (e.stderr) log += e.stderr + "\n";
    }
}

console.log("Running real-world git clone and setup...");
run("git clone https://github.com/bmorelli25/Express-Starter.git temp_express_test");
run("cd temp_express_test && npm install");
run("cd temp_express_test && ls");

fs.writeFileSync("real_test.log", log);
console.log("real_test.log generated.");
