import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface WindowsSelection {
  text: string
  sourceContext?: string
}

const SELECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

function Write-PiggyResult([string]$Text, [string]$SourceContext) {
  $payload = @{
    text = $Text.Trim()
    sourceContext = $SourceContext.Trim()
  } | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
}

# UI Automation is the fastest path and does not touch the clipboard. When it
# is available, also expand the selected range to its sentence for the saved
# word context.
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $element = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -ne $element) {
    $pattern = $null
    $available = $element.TryGetCurrentPattern(
      [System.Windows.Automation.TextPattern]::Pattern,
      [ref]$pattern
    )
    if ($available -and $null -ne $pattern) {
      $ranges = ([System.Windows.Automation.TextPattern]$pattern).GetSelection()
      $builder = New-Object System.Text.StringBuilder
      foreach ($range in $ranges) {
        [void]$builder.Append($range.GetText(-1))
      }

      $text = $builder.ToString().Trim()
      if (-not [string]::IsNullOrWhiteSpace($text)) {
        $sourceContext = ''
        if ($ranges.Count -eq 1) {
          try {
            $sentence = $ranges[0].Clone()
            $sentence.ExpandToEnclosingUnit([System.Windows.Automation.TextUnit]::Sentence)
            $sourceContext = $sentence.GetText(1200).Trim()
            if ($sourceContext -eq $text) { $sourceContext = '' }
          } catch { }
        }
        Write-PiggyResult $text $sourceContext
        exit 0
      }
    }
  }
} catch { }

# Some programs do not expose their selection through UI Automation. Use a
# short copy fallback, then restore every clipboard format that can be saved.
Add-Type -AssemblyName System.Windows.Forms
$savedClipboard = New-Object System.Windows.Forms.DataObject
$hasSavedData = $false
$fallbackText = ''

try {
  $sourceClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
  if ($null -ne $sourceClipboard) {
    foreach ($format in $sourceClipboard.GetFormats($false)) {
      try {
        $data = $sourceClipboard.GetData($format, $false)
        if ($null -ne $data) {
          $savedClipboard.SetData($format, $data)
          $hasSavedData = $true
        }
      } catch { }
    }
  }

  $marker = '__PIGGY_SELECTION_' + [Guid]::NewGuid().ToString('N')
  [System.Windows.Forms.Clipboard]::SetText($marker)
  Start-Sleep -Milliseconds 20
  [System.Windows.Forms.SendKeys]::SendWait('^c')

  for ($attempt = 0; $attempt -lt 18; $attempt++) {
    Start-Sleep -Milliseconds 35
    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
      $candidate = [System.Windows.Forms.Clipboard]::GetText()
      if ($candidate -ne $marker) {
        $fallbackText = $candidate.Trim()
        break
      }
    }
  }
} finally {
  try {
    if ($hasSavedData) {
      [System.Windows.Forms.Clipboard]::SetDataObject($savedClipboard, $true, 5, 40)
    } else {
      [System.Windows.Forms.Clipboard]::Clear()
    }
  } catch { }
}

if ([string]::IsNullOrWhiteSpace($fallbackText)) { exit 12 }
Write-PiggyResult $fallbackText ''
`

export async function readWindowsSelection(): Promise<WindowsSelection> {
  const encodedScript = Buffer.from(SELECTION_SCRIPT, 'utf16le').toString('base64')
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

  try {
    const { stdout } = await execFileAsync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Sta',
        '-EncodedCommand',
        encodedScript
      ],
      {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    )

    const encodedPayload = stdout.trim()
    if (!encodedPayload) throw new Error('empty selection')
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8')) as Partial<WindowsSelection>
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    const sourceContext = typeof payload.sourceContext === 'string' ? payload.sourceContext.trim() : ''
    if (!text) throw new Error('empty selection')
    return { text, sourceContext: sourceContext || undefined }
  } catch {
    throw new Error('没有读取到选中的文字。请确认文字已高亮后再按取词快捷键；受保护页面可能不支持取词。')
  }
}
