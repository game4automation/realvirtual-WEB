# plan-659 scaling spike — effective-clock sampler.
#
# Gives the knee a NAME. `PercentProcessorPerformance` is the ratio of the
# delivered clock to the NOMINAL clock (2200 MHz on this part), so
#   effective MHz = PercentProcessorPerformance / 100 * 2200
# and a value above 100 means turbo. Sampled once per second alongside the
# busy percentage, so a drop in delivered clock under many-core load is
# visible rather than inferred.
#
# Why not Get-Counter: that cmdlet takes ENGLISH counter paths and fails on a
# German-locale host. The CIM perf classes are locale-independent.
param(
  [int]$Seconds = 60,
  [string]$Out = "clock-samples.csv"
)
"t,perfPct,effMHz,busyPct" | Set-Content -Encoding utf8 $Out
for ($i = 0; $i -lt $Seconds; $i++) {
  $p = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'"
  $b = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
  $perf = [double]$p.PercentProcessorPerformance
  $eff = [math]::Round($perf / 100 * 2200, 0)
  "{0},{1},{2},{3}" -f $i, $perf, $eff, [double]$b.PercentProcessorTime | Add-Content -Encoding utf8 $Out
  Start-Sleep -Seconds 1
}
