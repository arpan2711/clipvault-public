; Extra NSIS steps for the ClipVault installer (electron-builder includes this file).
;
; ClipVault's "Start with Windows" setting (app.setLoginItemSettings in src/main.js) writes a value
; named after the app's AppUserModelId, com.clipvault.app, under HKCU\...\CurrentVersion\Run.
; The uninstaller removes it, but only when it points at this install (a copy run from source
; uses the same value name) and not while an update is replacing the old version.
; Clips and settings (%APPDATA%\ClipVault, Videos\ClipVault) are left alone.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.clipvault.app"
    StrCpy $R1 "$INSTDIR\"
    StrLen $R2 $R1
    StrCpy $R3 0
    cvLoginItemScan:
      StrCpy $R4 $R0 $R2 $R3
      StrCmp $R4 "" cvLoginItemDone
      StrCmp $R4 $R1 cvLoginItemFound ; StrCmp ignores case
      IntOp $R3 $R3 + 1
      Goto cvLoginItemScan
    cvLoginItemFound:
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.clipvault.app"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.clipvault.app"
    cvLoginItemDone:
  ${endIf}
!macroend
