#!/usr/bin/env node

if (process.argv[2] === "setup") {
    const { setup } = await import("./setup.js");
    setup(process.argv.slice(3)).catch((error) => {
        console.error(`\nSetup failed: ${(error as Error).message}`);
        process.exit(1);
    });
} else {
    await import("./index.js");
}
