; Verifone Edge Relay — NSIS Installer Script
; Produces: VerifoneEdgeRelay-Setup-{VERSION}.exe

!include "MUI2.nsh"
!include "nsDialogs.nsh"

; ── Metadata ──────────────────────────────────────────────────────────

!define PRODUCT_NAME "Verifone Edge Relay"
!define PRODUCT_VERSION "1.0.0"
!define PRODUCT_PUBLISHER "Nirlab Inc"
!define PRODUCT_WEB "https://shreai.com"
!define INSTALL_DIR "$PROGRAMFILES\Verifone Edge Relay"
!define DATA_DIR "$COMMONAPPDATA\VerifoneEdgeRelay"
!define SERVICE_NAME "VerifoneEdgeRelay"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "VerifoneEdgeRelay-Setup-${PRODUCT_VERSION}.exe"
InstallDir "${INSTALL_DIR}"
RequestExecutionLevel admin

; ── UI ────────────────────────────────────────────────────────────────

!define MUI_ABORTWARNING
!define MUI_ICON "..\..\admin-ui\favicon.ico"
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${PRODUCT_NAME} Setup"
!define MUI_WELCOMEPAGE_TEXT "This will install the Verifone Edge Relay on your computer.$\r$\n$\r$\nThe relay syncs data from your Verifone Commander to Shre AI for analytics and learning."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; ── Install ───────────────────────────────────────────────────────────

Section "Install"
  SetOutPath "$INSTDIR"

  ; Copy binary and dependencies
  File "..\..\dist\verifone-edge-relay.exe"
  File "..\..\dist\native\better_sqlite3.node"

  ; Copy admin UI
  SetOutPath "$INSTDIR\admin-ui"
  File "..\..\dist\admin-ui\index.html"
  File "..\..\dist\admin-ui\setup.html"
  File "..\..\dist\admin-ui\status.html"

  ; Copy WinSW for service management
  SetOutPath "$INSTDIR"
  File "winsw.exe"
  File "winsw.xml"

  ; Create data directory
  CreateDirectory "${DATA_DIR}"
  CreateDirectory "${DATA_DIR}\logs"

  ; Install Windows Service
  nsExec::ExecToLog '"$INSTDIR\winsw.exe" install'

  ; Start service
  nsExec::ExecToLog '"$INSTDIR\winsw.exe" start'

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Start menu shortcuts
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Setup Wizard.lnk" "http://localhost:18464/setup.html"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Dashboard.lnk" "http://localhost:18464/status.html"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  ; Add/Remove Programs entry
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "DisplayVersion" "${PRODUCT_VERSION}"

  ; Open browser to setup wizard
  ExecShell "open" "http://localhost:18464/setup.html"
SectionEnd

; ── Uninstall ─────────────────────────────────────────────────────────

Section "Uninstall"
  ; Stop and uninstall service
  nsExec::ExecToLog '"$INSTDIR\winsw.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\winsw.exe" uninstall'

  ; Remove files
  RMDir /r "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"

  ; Remove registry
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}"

  ; Note: data directory preserved intentionally (user data)
  MessageBox MB_YESNO "Remove relay data (reports, logs, config)?$\r$\nChoose No to keep your data." IDYES removeData IDNO done
  removeData:
    RMDir /r "${DATA_DIR}"
  done:
SectionEnd
