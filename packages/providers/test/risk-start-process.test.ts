import { describe, expect, it } from "vitest";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Three ways PowerShell commands got around the outside-the-worktree checks at Auto (#541, §11.2):
 * `Start-Process` (and its aliases `saps` and `start`) running reg, regedit, setx, a delete or an
 * inline script; item cmdlets fed by a pipe whose value is a script block
 * (`… | Rename-Item -NewName { … }`); and `Pop-Location`/`popd`, which never restored the location
 * before a `Push-Location`/`pushd`.
 */

const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  extraRoots: ["D:\\shared"],
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};
/** PowerShell, and the shell unknown (`auto`) on Windows. */
const ps: RiskContext = { ...win, shell: "powershell" };

const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};

describe("Start-Process (#541)", () => {
  it("asks when Start-Process runs a registry write, a permanent env change or a delete", () => {
    for (const cmd of [
      "Start-Process -FilePath reg.exe -ArgumentList 'add','HKCU\\Software\\Foo','/f'",
      "Start-Process regedit -ArgumentList '/s','x.reg'",
      "saps setx -ArgumentList 'PATH C:\\x'",
      "start reg -ArgumentList 'add HKCU\\Software\\Foo /f'",
      "Start-Process powershell -ArgumentList '-Command','Remove-Item C:\\Users\\me\\x -Recurse'",
      "Start-Process cmd -ArgumentList '/c rd /s /q C:\\Users\\me\\x'",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
    // With the shell unknown on Windows too.
    expect(action("start reg -ArgumentList 'add HKCU\\Software\\Foo /f'", win)).toBe(
      "outside_worktree",
    );
  });

  it("asks exactly as the same command run directly does", () => {
    for (const cmd of [
      "& reg add HKCU\\Software\\Foo /f",
      "cmd /c reg add HKCU\\Software\\Foo /f",
      'powershell -Command "Remove-Item C:\\Users\\me\\x -Recurse"',
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
  });
});

describe("piped item cmdlets with a script block (#541)", () => {
  it("asks when a listing outside the worktree is renamed, moved or changed with a script block", () => {
    for (const cmd of [
      "Get-ChildItem C:\\Users\\me\\Docs -Filter *.txt | Rename-Item -NewName { $_.Name -replace '.txt','.md' }",
      "Get-ChildItem C:\\Users\\me\\Docs | Move-Item -Destination { 'C:\\Users\\me\\Old\\' + $_.Name }",
      "Get-ChildItem C:\\Users\\me\\Docs | Set-ItemProperty -Name IsReadOnly -Value { $true }",
      "Get-Item HKCU:\\Software\\Foo | Set-ItemProperty -Name X -Value { 1 }",
      "Get-ChildItem C:\\Users\\me\\Docs | Where-Object { $_.Length -gt 0 } | Rename-Item -NewName { $_.Name + '.old' }",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
  });

  it("asks for the plain forms, as before", () => {
    for (const cmd of [
      "Get-ChildItem C:\\Users\\me\\Docs | Rename-Item -NewName x.bak",
      "Get-ChildItem C:\\Users\\me\\Docs | Move-Item -Destination C:\\Users\\me\\Old",
      "Get-ChildItem C:\\Users\\me\\Docs | Set-ItemProperty -Name IsReadOnly -Value $true",
    ]) {
      expect(action(cmd, ps), cmd).toBe("outside_worktree");
    }
  });
});

describe("Push-Location and Pop-Location (#541)", () => {
  it("restores the earlier location after Pop-Location or popd", () => {
    for (const cmd of [
      "Push-Location HKCU:\\Software; Pop-Location; Remove-Item dist -Recurse",
      "pushd HKCU:\\Software; popd; Remove-Item dist -Recurse",
      "Push-Location C:\\Users\\me; Pop-Location; Remove-Item dist -Recurse",
    ]) {
      expect(action(cmd, ps), cmd).toBeNull();
    }
  });
});
