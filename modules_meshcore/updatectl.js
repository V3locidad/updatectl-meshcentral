/*
 * updatectl — agent meshcore module.
 *
 * Inventaire et installation des Windows Updates via Microsoft.Update.Session
 * (COM), exécuté en SYSTEM par un PowerShell qu'on enveloppe dans un .bat
 * temporaire (mêmes raisons que softctl winget : MeshAgent en service bloque
 * stdio, et le quoting cmd /c est fragile dès qu'il y a des espaces).
 */

"use strict";

var mesh = null;

function dbg(m) {
    try {
        var fs = require('fs');
        var s = fs.createWriteStream('updatectl.txt', { flags: 'a' });
        s.write('\n' + new Date().toLocaleString() + ': ' + m);
        s.end('\n');
    } catch (e) {}
}

function reply(payload) {
    var msg = { action: 'plugin', plugin: 'updatectl' };
    Object.keys(payload).forEach(function (k) { msg[k] = payload[k]; });
    try {
        if (mesh && typeof mesh.SendCommand === 'function') mesh.SendCommand(msg);
        else require('MeshAgent').SendCommand(JSON.stringify(msg));
    } catch (e) { dbg('reply err: ' + e); }
}

function consoleaction(args, rights, sessionid, parent) {
    mesh = parent;
    var fnname = args.pluginaction || (args._ && args._[1]);
    try {
        switch (fnname) {
            case 'ping': reply({ pluginaction: 'pong', dispatchId: args.dispatchId }); return 'pong';
            case 'inventory': doInventory(args); return 'inv started';
            case 'install':   doInstall(args);   return 'install started';
            default: return 'updatectl: action inconnue ' + fnname;
        }
    } catch (e) { dbg('console err: ' + e); return 'err ' + e; }
}

module.exports = { consoleaction: consoleaction };

function toStr(buf) {
    if (typeof buf === 'string') return buf;
    if (!buf) return '';
    try { return buf.toString('utf8'); } catch (_) {}
    try { return String.fromCharCode.apply(null, buf); } catch (_) {}
    return '';
}

function runPs(script, timeoutMs, cb) {
    // Stratégie : on écrit le script dans un .ps1 sur disque (UTF-8 BOM pour
    // que PowerShell lise les accents correctement) et on l'exécute via
    // `-File`. Le script écrit son JSON dans le fichier pointé par
    // $env:UPDATECTL_OUT. stdout/stderr de PowerShell sont capturés à part
    // pour diag, mais pas utilisés pour la valeur de retour.
    var fs = require('fs');
    var cp = require('child_process');
    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var tmpRoot = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    var stamp = Date.now() + '_' + Math.floor(Math.random() * 1e9);
    var outFile = tmpRoot + '\\updatectl_' + stamp + '.out';
    var errFile = outFile + '.err';
    var ps1File = tmpRoot + '\\updatectl_' + stamp + '.ps1';
    var batFile = tmpRoot + '\\updatectl_' + stamp + '.bat';
    // UTF-8 BOM puis script texte. Évite tout encoding mojibake côté PS.
    try { fs.writeFileSync(ps1File, '﻿' + script); }
    catch (e) { return cb(e, ''); }
    var psExe = windir + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    var line = '"' + psExe + '" -NoProfile -ExecutionPolicy Bypass -NonInteractive -File "' + ps1File + '" > "' + errFile + '" 2>&1';
    try {
        fs.writeFileSync(batFile,
            '@echo off\r\n' +
            'set "UPDATECTL_OUT=' + outFile + '"\r\n' +
            line + '\r\n'
        );
    }
    catch (e) { return cb(e, ''); }
    var exe = windir + '\\System32\\cmd.exe';
    try {
        var child = cp.execFile(exe, ['/c', batFile]);
        var done2 = false;
        function finish(err) {
            if (done2) return; done2 = true;
            var out = '';
            var errOut = '';
            try { if (fs.existsSync(outFile)) out = toStr(fs.readFileSync(outFile, 'utf8')); } catch (_) {}
            try { if (fs.existsSync(errFile)) errOut = toStr(fs.readFileSync(errFile, 'utf8')); } catch (_) {}
            try { fs.unlinkSync(outFile); } catch (_) {}
            try { fs.unlinkSync(errFile); } catch (_) {}
            try { fs.unlinkSync(ps1File); } catch (_) {}
            try { fs.unlinkSync(batFile); } catch (_) {}
            // Si UPDATECTL_OUT n'a rien produit, on rabat sur le stderr de PS
            // (typiquement : erreur d'init avant le J final).
            cb(err, out || errOut);
        }
        child.on('exit', function () { finish(null); });
        setTimeout(function () { try { child.kill(); } catch (_) {} finish('timeout'); }, timeoutMs);
    } catch (e) { cb(e, ''); }
}

function parseJsonChunk(out) {
    // Extrait le bloc JSON (recherche d'une accolade ouvrante en début de ligne
    // jusqu'à la dernière accolade fermante). Tolère du texte autour.
    if (!out) return null;
    var first = out.indexOf('{');
    var last = out.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try { return JSON.parse(out.substring(first, last + 1)); } catch (_) { return null; }
}

function doInventory(args) {
    var dispatchId = args.dispatchId;
    var bypassWsus = !!args.bypassWsus;
    // Script : enumère les MAJ en attente, infos OS, reboot pending.
    var ps = [
        '$ErrorActionPreference = "Stop"',
        '$ProgressPreference = "SilentlyContinue"',
        '$WarningPreference = "SilentlyContinue"',
        '$VerbosePreference = "SilentlyContinue"',
        'function J($o){ $o | ConvertTo-Json -Compress -Depth 6 | Set-Content -Path $env:UPDATECTL_OUT -Encoding UTF8 }',
        '$result = @{ updates = @(); winver = ""; displayVersion = ""; ubr = ""; lastInstall = ""; rebootPending = $false; error = $null }',
        // Bypass WSUS = neutralise la GPO DoNotConnectToWindowsUpdateInternetLocations
        // le temps de la requête, on restaure ensuite.
        '$bypass = $' + (bypassWsus ? 'true' : 'false'),
        '$wuPolKey = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate"',
        '$savedDoNotConnect = $null',
        'if ($bypass) {',
        '  try {',
        '    if (Test-Path $wuPolKey) {',
        '      $prop = Get-ItemProperty -Path $wuPolKey -Name DoNotConnectToWindowsUpdateInternetLocations -ErrorAction SilentlyContinue',
        '      if ($prop) { $savedDoNotConnect = $prop.DoNotConnectToWindowsUpdateInternetLocations }',
        '      Set-ItemProperty -Path $wuPolKey -Name DoNotConnectToWindowsUpdateInternetLocations -Value 0 -ErrorAction SilentlyContinue',
        '    }',
        '  } catch {}',
        '}',
        'try {',
        '  $reg = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"',
        '  $v = Get-ItemProperty -Path $reg -ErrorAction SilentlyContinue',
        '  if ($v) {',
        '    $result.winver = "" + $v.ProductName',
        '    $result.displayVersion = "" + $v.DisplayVersion',
        '    $result.ubr = "" + $v.UBR',
        '  }',
        '  $rp = $false',
        '  if (Test-Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending") { $rp = $true }',
        '  if (Test-Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired") { $rp = $true }',
        '  $result.rebootPending = $rp',
        '  try {',
        '    $last = Get-HotFix -ErrorAction SilentlyContinue | Sort-Object InstalledOn -Descending | Select-Object -First 1',
        '    if ($last -and $last.InstalledOn) { $result.lastInstall = $last.InstalledOn.ToString("yyyy-MM-dd") }',
        '  } catch {}',
        '  $session = New-Object -ComObject Microsoft.Update.Session',
        '  $searcher = $session.CreateUpdateSearcher()',
        '  if ($bypass) { $searcher.ServerSelection = 2 }  # ssWindowsUpdate',
        '  $sr = $searcher.Search("IsInstalled=0 and IsHidden=0")',
        '  foreach ($u in $sr.Updates) {',
        '    $kb = ""',
        '    foreach ($k in $u.KBArticleIDs) { if ($kb) { $kb = $kb + "," } ; $kb = $kb + "KB" + $k }',
        '    $sev = ""',
        '    try { $sev = $u.MsrcSeverity } catch {}',
        '    $size = 0',
        '    try { $size = [int64]$u.MaxDownloadSize } catch {}',
        '    $result.updates += @{ id = $u.Identity.UpdateID; title = $u.Title; kb = $kb; severity = $sev; size = $size; downloaded = [bool]$u.IsDownloaded }',
        '  }',
        '} catch { $result.error = $_.Exception.Message }',
        // Restauration de la GPO si on l'avait neutralisée
        'if ($bypass -and (Test-Path $wuPolKey)) {',
        '  try {',
        '    if ($savedDoNotConnect -ne $null) {',
        '      Set-ItemProperty -Path $wuPolKey -Name DoNotConnectToWindowsUpdateInternetLocations -Value $savedDoNotConnect -ErrorAction SilentlyContinue',
        '    } else {',
        '      Remove-ItemProperty -Path $wuPolKey -Name DoNotConnectToWindowsUpdateInternetLocations -ErrorAction SilentlyContinue',
        '    }',
        '  } catch {}',
        '}',
        'J $result',
    ].join("\n");
    runPs(ps, 4 * 60 * 1000, function (err, out) {
        if (err && !out) return reply({ pluginaction: 'inventoryResult', dispatchId: dispatchId, error: String(err) });
        var j = parseJsonChunk(out);
        if (!j) return reply({ pluginaction: 'inventoryResult', dispatchId: dispatchId, error: 'parse JSON impossible', raw: (out || '').slice(-1500) });
        if (j.error) return reply({ pluginaction: 'inventoryResult', dispatchId: dispatchId, error: j.error, raw: (out || '').slice(-1500) });
        reply({
            pluginaction: 'inventoryResult',
            dispatchId: dispatchId,
            winver: j.winver || '',
            displayVersion: j.displayVersion || '',
            ubr: j.ubr || '',
            lastInstall: j.lastInstall || '',
            rebootPending: !!j.rebootPending,
            updates: j.updates || [],
        });
    });
}

function doInstall(args) {
    var dispatchId = args.dispatchId;
    var all = !!args.all;
    var ids = (args.updateIds || []).map(String);
    var bypassWsus = !!args.bypassWsus;
    // Script : search again, filter to selected ids (ou tout), download + install,
    // retourne installed[] / failed[] / rebootRequired.
    var idsList = ids.map(function (s) { return "'" + s.replace(/'/g, "''") + "'"; }).join(',');
    var ps = [
        '$ErrorActionPreference = "Stop"',
        '$ProgressPreference = "SilentlyContinue"',
        '$WarningPreference = "SilentlyContinue"',
        '$VerbosePreference = "SilentlyContinue"',
        'function J($o){ $o | ConvertTo-Json -Compress -Depth 6 | Set-Content -Path $env:UPDATECTL_OUT -Encoding UTF8 }',
        '$wanted = @(' + idsList + ')',
        '$all = $' + (all ? 'true' : 'false'),
        '$bypass = $' + (bypassWsus ? 'true' : 'false'),
        '$result = @{ installed = @(); failed = @(); rebootRequired = $false; error = $null }',
        '$wuPolKey = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate"',
        '$savedDoNotConnect = $null',
        'if ($bypass) {',
        '  try {',
        '    if (Test-Path $wuPolKey) {',
        '      $prop = Get-ItemProperty -Path $wuPolKey -Name DoNotConnectToWindowsUpdateInternetLocations -ErrorAction SilentlyContinue',
        '      if ($prop) { $savedDoNotConnect = $prop.DoNotConnectToWindowsUpdateInternetLocations }',
        '      Set-ItemProperty -Path $wuPolKey -Name DoNotConnectToWindowsUpdateInternetLocations -Value 0 -ErrorAction SilentlyContinue',
        '    }',
        '  } catch {}',
        '}',
        'try {',
        '  $session = New-Object -ComObject Microsoft.Update.Session',
        '  $searcher = $session.CreateUpdateSearcher()',
        '  if ($bypass) { $searcher.ServerSelection = 2 }',
        '  $sr = $searcher.Search("IsInstalled=0 and IsHidden=0")',
        '  $col = New-Object -ComObject Microsoft.Update.UpdateColl',
        '  foreach ($u in $sr.Updates) {',
        '    if ($all -or ($wanted -contains $u.Identity.UpdateID)) {',
        '      if (-not $u.EulaAccepted) { try { $u.AcceptEula() } catch {} }',
        '      $col.Add($u) | Out-Null',
        '    }',
        '  }',
        '  if ($col.Count -eq 0) { $result.error = "aucune mise à jour à installer" } else {',
        '    $dl = $session.CreateUpdateDownloader()',
        '    $dl.Updates = $col',
        '    $dlres = $dl.Download()',
        '    $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl',
        '    foreach ($u in $col) { if ($u.IsDownloaded) { $toInstall.Add($u) | Out-Null } else { $result.failed += @{ id = $u.Identity.UpdateID; title = $u.Title; error = "download échoué" } } }',
        '    if ($toInstall.Count -gt 0) {',
        '      $ins = $session.CreateUpdateInstaller()',
        '      $ins.Updates = $toInstall',
        '      $inres = $ins.Install()',
        '      $result.rebootRequired = [bool]$inres.RebootRequired',
        '      for ($i = 0; $i -lt $toInstall.Count; $i++) {',
        '        $u = $toInstall.Item($i)',
        '        $r = $inres.GetUpdateResult($i)',
        '        if ($r.ResultCode -eq 2) { $result.installed += @{ id = $u.Identity.UpdateID; title = $u.Title } }',
        '        else { $result.failed += @{ id = $u.Identity.UpdateID; title = $u.Title; error = "install code " + $r.ResultCode + " hresult 0x" + ("{0:x}" -f $r.HResult) } }',
        '      }',
        '    }',
        '  }',
        '} catch { $result.error = $_.Exception.Message }',
        'if ($bypass -and (Test-Path $wuPolKey)) {',
        '  try {',
        '    if ($savedDoNotConnect -ne $null) {',
        '      Set-ItemProperty -Path $wuPolKey -Name DoNotConnectToWindowsUpdateInternetLocations -Value $savedDoNotConnect -ErrorAction SilentlyContinue',
        '    } else {',
        '      Remove-ItemProperty -Path $wuPolKey -Name DoNotConnectToWindowsUpdateInternetLocations -ErrorAction SilentlyContinue',
        '    }',
        '  } catch {}',
        '}',
        'J $result',
    ].join("\n");
    runPs(ps, 55 * 60 * 1000, function (err, out) {
        if (err && !out) return reply({ pluginaction: 'installResult', dispatchId: dispatchId, error: String(err) });
        var j = parseJsonChunk(out);
        if (!j) return reply({ pluginaction: 'installResult', dispatchId: dispatchId, error: 'parse JSON impossible', raw: (out || '').slice(-2000) });
        reply({
            pluginaction: 'installResult',
            dispatchId: dispatchId,
            error: j.error || undefined,
            installed: j.installed || [],
            failed: j.failed || [],
            rebootRequired: !!j.rebootRequired,
            raw: (out || '').slice(-2000),
        });
    });
}
