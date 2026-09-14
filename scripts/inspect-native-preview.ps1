param([Parameter(Mandatory=$true)][int]$PreviewProcessId)
# Read-only diagnostic: enumerate only the specified process's native windows.
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public class PreviewWindowState {
 public delegate bool Callback(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback f, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, Callback f, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder b, int n);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint cmd);
 public struct Rect {public int l,t,r,b;}
 public static string Inspect(IntPtr h){var b=new StringBuilder(256);GetClassName(h,b,256); Rect r;GetClientRect(h,out r);return h+" "+b+" parent="+GetParent(h)+" previousSibling="+GetWindow(h,3)+" style="+GetWindowLong(h,-16).ToString("x")+" size="+r.r+"x"+r.b;}
 public static void Dump(int process){EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==process){Console.WriteLine(Inspect(h));EnumChildWindows(h,(c,a)=>{Console.WriteLine("  "+Inspect(c));return true;},IntPtr.Zero);}return true;},IntPtr.Zero);}
}
'@
[PreviewWindowState]::Dump($PreviewProcessId)
