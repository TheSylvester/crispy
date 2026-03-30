; Kill running Crispy and its bundled node.exe before install/upgrade.
; Without this, Windows locks the running executables and the installer
; fails with "Error opening file for writing".

!macro NSIS_HOOK_PREINSTALL
  ; Kill Crispy.exe (the Tauri shell)
  nsExec::ExecToLog 'taskkill /F /IM "Crispy.exe" /T'
  ; Kill any bundled node.exe spawned by Crispy (the daemon)
  ; We target only node.exe running from the Crispy install dir
  nsExec::ExecToLog 'cmd /c "wmic process where $\"ExecutablePath like $\'%AppData%\\Local\\Crispy%$\' and Name=$\'node.exe$\'$\" call terminate"'
  ; Brief pause to let file handles release
  Sleep 1000
!macroend
