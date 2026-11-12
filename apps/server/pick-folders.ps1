param(
  [switch]$Probe
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace TrellisFolderPicker
{
    [Flags]
    internal enum FileOpenOptions : uint
    {
        PickFolders = 0x00000020,
        ForceFileSystem = 0x00000040,
        AllowMultiSelect = 0x00000200,
        PathMustExist = 0x00000800
    }

    internal enum ShellItemDisplayName : uint
    {
        FileSystemPath = 0x80058000
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    [ClassInterface(ClassInterfaceType.None)]
    internal class FileOpenDialog
    {
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid interfaceId, out IntPtr result);
        [PreserveSig] int GetParent(out IShellItem parent);
        [PreserveSig] int GetDisplayName(ShellItemDisplayName displayName, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare(IShellItem item, uint hint, out int order);
    }

    [ComImport]
    [Guid("B63EA76D-1F85-456F-A19C-48159EFA858B")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItemArray
    {
        [PreserveSig] int BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid interfaceId, out IntPtr result);
        [PreserveSig] int GetPropertyStore(uint flags, ref Guid interfaceId, out IntPtr result);
        [PreserveSig] int GetPropertyDescriptionList(IntPtr keyType, ref Guid interfaceId, out IntPtr result);
        [PreserveSig] int GetAttributes(uint flags, uint mask, out uint attributes);
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetItemAt(uint index, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
        [PreserveSig] int EnumItems(out IntPtr items);
    }

    [ComImport]
    [Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        [PreserveSig] int SetFileTypes(uint count, IntPtr filterSpec);
        [PreserveSig] int SetFileTypeIndex(uint index);
        [PreserveSig] int GetFileTypeIndex(out uint index);
        [PreserveSig] int Advise(IntPtr events, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOptions(FileOpenOptions options);
        [PreserveSig] int GetOptions(out FileOpenOptions options);
        [PreserveSig] int SetDefaultFolder(IShellItem folder);
        [PreserveSig] int SetFolder(IShellItem folder);
        [PreserveSig] int GetFolder(out IShellItem folder);
        [PreserveSig] int GetCurrentSelection(out IShellItem item);
        [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        [PreserveSig] int GetResult(out IShellItem item);
        [PreserveSig] int AddPlace(IShellItem item, uint location);
        [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        [PreserveSig] int Close(int result);
        [PreserveSig] int SetClientGuid(ref Guid guid);
        [PreserveSig] int ClearClientData();
        [PreserveSig] int SetFilter(IntPtr filter);
    }

    [ComImport]
    [Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        [PreserveSig] int SetFileTypes(uint count, IntPtr filterSpec);
        [PreserveSig] int SetFileTypeIndex(uint index);
        [PreserveSig] int GetFileTypeIndex(out uint index);
        [PreserveSig] int Advise(IntPtr events, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOptions(FileOpenOptions options);
        [PreserveSig] int GetOptions(out FileOpenOptions options);
        [PreserveSig] int SetDefaultFolder(IShellItem folder);
        [PreserveSig] int SetFolder(IShellItem folder);
        [PreserveSig] int GetFolder(out IShellItem folder);
        [PreserveSig] int GetCurrentSelection(out IShellItem item);
        [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        [PreserveSig] int GetResult(out IShellItem item);
        [PreserveSig] int AddPlace(IShellItem item, uint location);
        [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        [PreserveSig] int Close(int result);
        [PreserveSig] int SetClientGuid(ref Guid guid);
        [PreserveSig] int ClearClientData();
        [PreserveSig] int SetFilter(IntPtr filter);
        [PreserveSig] int GetResults([MarshalAs(UnmanagedType.Interface)] out IShellItemArray items);
        [PreserveSig] int GetSelectedItems([MarshalAs(UnmanagedType.Interface)] out IShellItemArray items);
    }

    public static class Picker
    {
        private const int Cancelled = unchecked((int)0x800704C7);

        private static IFileOpenDialog CreateDialog()
        {
            return (IFileOpenDialog)new FileOpenDialog();
        }

        private static void Check(int result)
        {
            Marshal.ThrowExceptionForHR(result);
        }

        private static void EnableMultiFolderSelection(IFileOpenDialog dialog)
        {
            FileOpenOptions options;
            Check(dialog.GetOptions(out options));
            options |= FileOpenOptions.PickFolders
                | FileOpenOptions.ForceFileSystem
                | FileOpenOptions.AllowMultiSelect
                | FileOpenOptions.PathMustExist;
            Check(dialog.SetOptions(options));
        }

        public static uint ProbeOptions()
        {
            IFileOpenDialog dialog = CreateDialog();
            EnableMultiFolderSelection(dialog);
            FileOpenOptions options;
            Check(dialog.GetOptions(out options));
            return (uint)options;
        }

        public static string[] PickFolders()
        {
            string stage = "create";
            try {
                IFileOpenDialog dialog = CreateDialog();
                stage = "configure";
                EnableMultiFolderSelection(dialog);
                Check(dialog.SetTitle("\u9009\u62e9 Trellis \u9879\u76ee\u6587\u4ef6\u5939"));

                stage = "show";
                int result = dialog.Show(IntPtr.Zero);
                if (result == Cancelled) {
                    return Array.Empty<string>();
                }
                Check(result);

                stage = "get-results";
                IShellItemArray selectedItems;
                Check(dialog.GetResults(out selectedItems));
                stage = "get-count";
                uint count;
                Check(selectedItems.GetCount(out count));

                stage = "read-folders";
                var paths = new List<string>((int)count);
                for (uint index = 0; index < count; index++) {
                    stage = "get-item-" + index;
                    IShellItem item;
                    Check(selectedItems.GetItemAt(index, out item));
                    stage = "get-display-name-" + index;
                    IntPtr displayName;
                    Check(item.GetDisplayName(ShellItemDisplayName.FileSystemPath, out displayName));
                    try {
                        stage = "copy-path-" + index;
                        paths.Add(Marshal.PtrToStringUni(displayName));
                    }
                    finally {
                        Marshal.FreeCoTaskMem(displayName);
                    }
                }
                return paths.ToArray();
            }
            catch (Exception error) {
                throw new InvalidOperationException("Folder picker failed at " + stage, error);
            }
        }
    }
}
'@

if ($Probe) {
    $options = [TrellisFolderPicker.Picker]::ProbeOptions()
    [pscustomobject]@{
        options = $options
        pickFolders = (($options -band 0x20) -ne 0)
        allowMultiSelect = (($options -band 0x200) -ne 0)
        pathMustExist = (($options -band 0x800) -ne 0)
    } | ConvertTo-Json -Compress
    exit 0
}

$paths = [TrellisFolderPicker.Picker]::PickFolders()
$json = ConvertTo-Json -InputObject ([string[]]$paths) -Compress
[Console]::Out.WriteLine("TRELLIS_JSON:$json")
