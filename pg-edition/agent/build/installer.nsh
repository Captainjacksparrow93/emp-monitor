; Silent install support: EmpMonitor-Agent-Setup.exe /S
; Optional: an enroll.json placed next to the installer is copied to %ProgramData%\EmpMonitorAgent
; so the agent enrolls itself on first launch (mass deployment via Intune / GPO / RMM).
!macro customInstall
  IfFileExists "$EXEDIR\enroll.json" 0 skip_enroll
    ReadEnvStr $0 PROGRAMDATA
    CreateDirectory "$0\EmpMonitorAgent"
    CopyFiles /SILENT "$EXEDIR\enroll.json" "$0\EmpMonitorAgent\enroll.json"
  skip_enroll:
!macroend

; On uninstall, stop the agent and remove its keep-alive scheduled task so it cannot relaunch.
!macro customUnInstall
  nsExec::Exec 'schtasks /End /TN "EmpMonitor Agent"'
  nsExec::Exec 'schtasks /Delete /TN "EmpMonitor Agent" /F'
  nsExec::Exec 'taskkill /F /IM "EmpMonitor Agent.exe" /T'
!macroend
