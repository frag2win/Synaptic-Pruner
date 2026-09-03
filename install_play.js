const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

https.get('https://getrote.dev/playoffs/install.sh', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        fs.writeFileSync('install_play.sh', data, 'utf-8');
        try {
            console.log(execSync('bash -x install_play.sh', { encoding: 'utf-8', env: {...process.env, PATH: '/home/shubham_pawar/.local/bin:' + process.env.PATH} }));
        } catch(e) {
            console.log(e.stdout);
            console.error(e.stderr);
        }
    });
});
