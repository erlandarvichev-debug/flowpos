param([string]$Docx,[string]$Pdf)
$ErrorActionPreference = 'Stop'
$taskWord = New-Object -ComObject Word.Application
$taskWord.Visible = $false
$taskWord.DisplayAlerts = 0
try {
  $taskDocument = $taskWord.Documents.Open($Docx, $false, $true)
  try {
    $taskDocument.Repaginate()
    $taskDocument.ExportAsFixedFormat($Pdf,17)
    Write-Output ('Word rendered pages: ' + $taskDocument.ComputeStatistics(2))
  } finally {
    $taskDocument.Close(0)
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($taskDocument) | Out-Null
  }
} finally {
  $taskWord.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($taskWord) | Out-Null
}
