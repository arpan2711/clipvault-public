// Starts ClipVault with Electron. Clears ELECTRON_RUN_AS_NODE, which some editors (such as
// VS Code) set for their terminals and which would make Electron behave like plain Node.
const { spawn } = require('child_process');
const electron = require('electron'); // resolves to the path of electron.exe when run from Node

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [__dirname, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
