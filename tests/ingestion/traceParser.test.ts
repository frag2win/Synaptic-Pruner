import { describe, it, expect } from "vitest";
import { parseTrace } from "../../src/ingestion/traceParser";

describe("traceParser", () => {
  it("should parse a basic linux transcript", () => {
    const raw = `
user@ubuntu:~/workspace$ ls -la
total 12
drwxr-xr-x 2 user user 4096 Sep  3 10:00 .
drwxr-xr-x 3 user user 4096 Sep  3 10:00 ..
-rw-r--r-- 1 user user   21 Sep  3 10:00 file.txt
user@ubuntu:~/workspace$ cat file.txt
Hello world
    `;
    
    const events = parseTrace(raw.trim());
    expect(events.length).toBe(2);
    
    expect(events[0].command).toBe("ls -la");
    expect(events[0].cwd).toBe("~/workspace");
    expect(events[0].exitCode).toBe(0);
    expect(events[0].stdout).toContain("total 12");
    
    expect(events[1].command).toBe("cat file.txt");
    expect(events[1].stdout).toBe("Hello world");
  });

  it("should parse a Windows PowerShell transcript", () => {
    const raw = `
PS C:\\Users\\Dev\\Desktop> echo "Testing"
Testing
PS C:\\Users\\Dev\\Desktop> npm install
added 10 packages in 2s
    `;
    
    const events = parseTrace(raw.trim());
    expect(events.length).toBe(2);
    
    expect(events[0].command).toBe('echo "Testing"');
    expect(events[0].cwd).toBe('C:\\Users\\Dev\\Desktop');
    expect(events[0].stdout).toBe('Testing');
    
    expect(events[1].command).toBe('npm install');
    expect(events[1].stdout).toBe('added 10 packages in 2s');
  });

  it("should identify heuristic errors and set exitCode to 1", () => {
    const raw = `
user@mac:~/project % unknown-cmd
bash: unknown-cmd: command not found
user@mac:~/project % npm run build
Error: build failed randomly
    `;
    
    const events = parseTrace(raw.trim());
    expect(events.length).toBe(2);
    
    expect(events[0].command).toBe("unknown-cmd");
    expect(events[0].exitCode).toBe(1);
    expect(events[0].stderr).toContain("command not found");
    
    expect(events[1].command).toBe("npm run build");
    expect(events[1].exitCode).toBe(1);
    expect(events[1].stderr).toContain("Error: build failed randomly");
  });

  it("should clean carriage returns during parsing", () => {
    const raw = "user@ubuntu:~$ download\r\nProgress 10%\rProgress 50%\rProgress 100%\nDone.";
    const events = parseTrace(raw.trim());
    
    expect(events.length).toBe(1);
    expect(events[0].command).toBe("download");
    // \r\n and \r both become \n, so we get multiple lines
    expect(events[0].stdout).toBe("Progress 10%\nProgress 50%\nProgress 100%\nDone.");
  });
});
