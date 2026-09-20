; A full uninstall is a clean application reinstall boundary. Updates pass
; /UPDATE and preserve state. User ADK/workspace files are outside BUNDLEID.
!macro NSIS_HOOK_PREINSTALL
  ; Installer-owned dependency trees can contain files introduced by an older
  ; release that NSIS no longer knows how to remove. Replace these trees as a
  ; unit so an update cannot run a stale Agent or stale node_modules package.
  RMDir /r "$INSTDIR\agent"
  RMDir /r "$INSTDIR\assets"
  RMDir /r "$INSTDIR\bgm-sidecar"
  RMDir /r "$INSTDIR\cascade-loader"
  RMDir /r "$INSTDIR\cascade-runtime"
  RMDir /r "$INSTDIR\herdr"
  RMDir /r "$INSTDIR\voxcpm2-runtime"
  RMDir /r "$INSTDIR\~"
!macroend

; `naia` is the stable command-line product name while the installed binary
; deliberately remains naia-shell.exe for updater and shortcut compatibility.
; WindowsApps is already on the per-user PATH on supported Windows installs,
; so the alias does not require a process-wide PATH mutation or elevation.
!macro NSIS_HOOK_POSTINSTALL
  StrCpy $0 "$LOCALAPPDATA\Microsoft\WindowsApps"
  CreateDirectory "$0"

  ; The private Discord operator tooling used to own naia.cmd. Migrate only
  ; that exact managed launcher; never overwrite an unrelated user command.
  ${If} ${FileExists} "$0\naia.cmd"
    FileOpen $1 "$0\naia.cmd" r
    FileRead $1 $2
    FileRead $1 $3
    FileClose $1
    ${If} $3 == "REM managed by naia-adk manage-discord-sessions$\r$\n"
      Delete "$0\naia.cmd"
    ${EndIf}
    ${If} $3 == "REM managed by Naia Shell installer$\r$\n"
      Delete "$0\naia.cmd"
    ${EndIf}
  ${EndIf}

  ${IfNot} ${FileExists} "$0\naia.cmd"
    FileOpen $1 "$0\naia.cmd" w
    FileWrite $1 "@echo off$\r$\n"
    FileWrite $1 "REM managed by Naia Shell installer$\r$\n"
    FileWrite $1 '"$INSTDIR\naia-shell.exe" %*$\r$\n'
    FileClose $1
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; Remove only the alias created by this installer. A user-owned naia.cmd
    ; at the same location must survive uninstall.
    StrCpy $0 "$LOCALAPPDATA\Microsoft\WindowsApps\naia.cmd"
    ${If} ${FileExists} "$0"
      FileOpen $1 "$0" r
      FileRead $1 $2
      FileRead $1 $3
      FileClose $1
      ${If} $3 == "REM managed by Naia Shell installer$\r$\n"
        Delete "$0"
      ${EndIf}
    ${EndIf}
    ; Tauri removes tracked files first. Remove only the exact Naia install
    ; root afterward so untracked dependency residue cannot survive a full
    ; uninstall. ~/.naia and user workspaces are deliberately outside it.
    RMDir /r "$INSTDIR"
  ${EndIf}
!macroend
