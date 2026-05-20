; Tauri NSIS installer hooks for Naia
; Moves Windows runtime DLLs from agent/dist/ to $INSTDIR (next to exe)
; so the Tauri STT plugin (libvosk) can find them via standard DLL search.

!macro NSIS_HOOK_POSTINSTALL
  Rename "$INSTDIR\agent\dist\libvosk.dll" "$INSTDIR\libvosk.dll"
  Rename "$INSTDIR\agent\dist\libgcc_s_seh-1.dll" "$INSTDIR\libgcc_s_seh-1.dll"
  Rename "$INSTDIR\agent\dist\libstdc++-6.dll" "$INSTDIR\libstdc++-6.dll"
  Rename "$INSTDIR\agent\dist\libwinpthread-1.dll" "$INSTDIR\libwinpthread-1.dll"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\libvosk.dll"
  Delete "$INSTDIR\libgcc_s_seh-1.dll"
  Delete "$INSTDIR\libstdc++-6.dll"
  Delete "$INSTDIR\libwinpthread-1.dll"
!macroend
