; M6 学习伙伴服务端 Windows 安装包（NSIS）
; 功能：安装 learning-server.exe 到 Program Files，注册为 Windows 服务（NSSM）→ 开机自启、免登录、崩溃自动重启。
; 构建：将 nssm.exe（https://nssm.cc/ 下载 64 位版）与本脚本放在同目录，用 makensis 编译：
;   makensis installer.nsi  →  learning-server-setup.exe
; 卸载：nssm stop/remove 服务 + 删除安装目录（数据目录保留在 $INSTDIR\data，由用户决定是否删除）。

!include "MUI2.nsh"
!include "x64.nsh"

Name "学习伙伴服务端"
OutFile "learning-server-setup.exe"
Unicode True
RequestExecutionLevel admin
InstallDir "$PROGRAMFILES64\LearningServer"
InstallDirRegKey HKLM "Software\LearningServer" "InstallDir"

; 安装页
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

; 服务名（与卸载一致）
!define SRV "LearningServer"

Section "Install"
  SetOutPath "$INSTDIR"

  ; 服务端可执行 + NSSM（随包附带；若未放置则安装跳过服务注册并提示）
  File "..\dist\learning-server.exe"
  IfFileExists "$INSTDIR\..\dist\nssm.exe" 0 +2
  File "..\dist\nssm.exe"

  ; 服务端数据目录
  CreateDirectory "$INSTDIR\data"
  WriteRegStr HKLM "Software\LearningServer" "InstallDir" "$INSTDIR"

  ; 注册为 Windows 服务（NSSM）：开机自启 + 崩溃自动重启
  IfFileExists "$INSTDIR\nssm.exe" 0 noNssm
    nsExec::Exec '"$INSTDIR\nssm.exe" install ${SRV} "$INSTDIR\learning-server.exe"'
    nsExec::Exec '"$INSTDIR\nssm.exe" set ${SRV} AppDirectory "$INSTDIR"'
    nsExec::Exec '"$INSTDIR\nssm.exe" set ${SRV} AppStdout "$INSTDIR\data\server.log"'
    nsExec::Exec '"$INSTDIR\nssm.exe" set ${SRV} AppStderr "$INSTDIR\data\server.log"'
    nsExec::Exec '"$INSTDIR\nssm.exe" set ${SRV} AppRotateFiles 1'
    nsExec::Exec '"$INSTDIR\nssm.exe" set ${SRV} Start SERVICE_AUTO_START'
    nsExec::Exec '"$INSTDIR\nssm.exe" set ${SRV} AppExit Default Restart'
    nsExec::Exec '"$INSTDIR\nssm.exe" set ${SRV} AppRestartDelay 3000'
    nsExec::Exec '"$INSTDIR\nssm.exe" set ${SRV} Description "学习伙伴服务端：数据唯一真源 + 认证代理 + 学习资料与配置下发"'
    nsExec::Exec 'net start ${SRV}'
    Goto done
  noNssm:
    MessageBox MB_ICONEXCLAMATION "未找到 nssm.exe，跳过服务注册（服务端可手动运行 $INSTDIR\learning-server.exe）"
  done:

  ; 卸载入口
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LearningServer" "DisplayName" "学习伙伴服务端"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LearningServer" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LearningServer" "DisplayVersion" "0.1.0"
SectionEnd

Section "Uninstall"
  ; 停止并移除服务
  nsExec::Exec 'net stop ${SRV}'
  IfFileExists "$INSTDIR\nssm.exe" 0 +2
  nsExec::Exec '"$INSTDIR\nssm.exe" remove ${SRV} confirm'
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LearningServer"
  DeleteRegKey HKLM "Software\LearningServer"
  ; 删除程序文件（data 数据目录保留，由用户自行决定）
  RMDir /r "$INSTDIR"
SectionEnd
