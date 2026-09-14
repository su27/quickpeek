# Read-only diagnostic of the same WinRT pipeline as windows_image_renderer.rs.
# No UI, no converted image is written, and no QuickPeek settings are changed.
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$script:asyncMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await-Result($Operation, [Type]$ResultType) {
    $task = $script:asyncMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(30000)) { throw 'WinRT diagnostic timed out' }
    return $task.Result
}
foreach ($mode in @('PNG-4096-run1','PNG-4096-run2','JPEG-4096','PNG-2048')) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $file = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $Path).Path)) ([Windows.Storage.StorageFile])
    $inputStream = Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $openMs = $timer.Elapsed.TotalMilliseconds
    $bitmap = $null; $output = $null
    try {
        $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($inputStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $frame = Await-Result ($decoder.GetFrameAsync(0)) ([Windows.Graphics.Imaging.BitmapFrame])
        $width = $frame.OrientedPixelWidth; $height = $frame.OrientedPixelHeight
        $headerMs = $timer.Elapsed.TotalMilliseconds
        $limit = if ($mode -eq 'PNG-2048') {2048} else {4096}
        $scale = [Math]::Min(1.0, $limit / [double][Math]::Max($width,$height))
        $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
        $transform.ScaledWidth = [uint32][Math]::Round($width*$scale)
        $transform.ScaledHeight = [uint32][Math]::Round($height*$scale)
        $bitmap = Await-Result ($frame.GetSoftwareBitmapAsync(
            [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
            $transform,
            [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
            [Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRgb
        )) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $pixelsMs = $timer.Elapsed.TotalMilliseconds
        $output = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        $encoderId = if ($mode -eq 'JPEG-4096') {[Windows.Graphics.Imaging.BitmapEncoder]::JpegEncoderId} else {[Windows.Graphics.Imaging.BitmapEncoder]::PngEncoderId}
        $encoder = Await-Result ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync($encoderId, $output)) ([Windows.Graphics.Imaging.BitmapEncoder])
        $encoder.SetSoftwareBitmap($bitmap)
        $actionMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
        } | Select-Object -First 1
        $action = $actionMethod.Invoke($null, @($encoder.FlushAsync()))
        if (-not $action.Wait(30000)) { throw 'Encoder diagnostic timed out' }
        $encodeMs = $timer.Elapsed.TotalMilliseconds
        $reader = [Windows.Storage.Streams.DataReader]::new($output.GetInputStreamAt(0))
        $null = Await-Result ($reader.LoadAsync([uint32]$output.Size)) ([uint32])
        $buffer = New-Object byte[] ([int]$output.Size)
        $reader.ReadBytes($buffer)
        $reader.Dispose()
        [pscustomobject]@{
            mode=$mode; width=$width; height=$height; outputWidth=$transform.ScaledWidth; outputHeight=$transform.ScaledHeight;
            openMs=[Math]::Round($openMs); headerMs=[Math]::Round($headerMs-$openMs);
            decodeMs=[Math]::Round($pixelsMs-$headerMs); encodeMs=[Math]::Round($encodeMs-$pixelsMs);
            copyMs=[Math]::Round($timer.Elapsed.TotalMilliseconds-$encodeMs);
            totalMs=[Math]::Round($timer.Elapsed.TotalMilliseconds); outputBytes=$output.Size
        } | ConvertTo-Json -Compress
    } finally {
        if ($bitmap) { $bitmap.Dispose() }
        if ($output) { $output.Dispose() }
        $inputStream.Dispose()
    }
}
