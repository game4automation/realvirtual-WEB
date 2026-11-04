@echo off
rem Isaac Sim nur mit dem NVIDIA-Vulkan-Treiber starten (Intel-iGPU ist doppelt registriert).
rem Der Pfad wird bei jedem Start aus der Registry gelesen, er aendert sich mit jedem Treiber-Update.
setlocal
set "VK_ICD_FILENAMES="
for /f "tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}" /s /v VulkanDriverName 2^>nul ^| findstr /i "nv-vk64.json"') do set "VK_ICD_FILENAMES=%%B"
if not defined VK_ICD_FILENAMES (
  echo NVIDIA-Vulkan-Treiber nicht gefunden.
  pause
  exit /b 1
)
echo Vulkan ICD: %VK_ICD_FILENAMES%
call "%~dp0run_isaac_sim_with_realvirtual.bat" --/renderer/activeGpu=0 %*
endlocal
