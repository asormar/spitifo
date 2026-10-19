; NSIS installer hooks, wired in through bundle.windows.nsis.installerHooks.
;
; Installing over an older release only overwrites files: anything the old
; release shipped and the new one dropped stays behind (0.2.0's shared-library
; ffmpeg DLLs, 157 MB, and the previous build's hashed frontend assets). Tauri's
; template never purges resource folders, and an upgrade run by the updater
; (/UPDATE), in passive mode or silently skips the old uninstaller altogether;
; even when it runs, it deletes only the files its own release knew about. So
; the program's own resource folders are wiped here, before the new ones are
; copied.
;
; The install folder also holds the user's data (tokens\, cache\, yt-dlp\,
; storage.json, device_id), which must survive an upgrade: only the four
; resource folders below are touched, never $INSTDIR itself.

!macro SPITIFO_REMOVE_RESOURCE_DIR dir
  ClearErrors
  RMDir /r "$INSTDIR\${dir}"
  ; The backend sidecar dies with the app, but not instantly: retry once
  ; before letting File overwrite whatever is still locked. No /REBOOTOK: it
  ; would schedule the paths for deletion and take the new files with them.
  ${If} ${Errors}
    Sleep 1500
    RMDir /r "$INSTDIR\${dir}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Only clean a folder that already holds this app: an empty $INSTDIR would
  ; turn "$INSTDIR\backend" into "\backend" on the current drive, and a fresh
  ; install into a folder that happens to contain a "backend" must not lose it.
  ${If} $INSTDIR != ""
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; The template runs this check right after the hook; the app and its
    ; sidecar hold files open in these folders, so close them first.
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    !insertmacro SPITIFO_REMOVE_RESOURCE_DIR "backend"
    !insertmacro SPITIFO_REMOVE_RESOURCE_DIR "ffmpeg"
    !insertmacro SPITIFO_REMOVE_RESOURCE_DIR "frontend"
    !insertmacro SPITIFO_REMOVE_RESOURCE_DIR "qjs"
  ${EndIf}
!macroend
