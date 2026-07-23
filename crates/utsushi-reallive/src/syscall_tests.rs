use super::*;
use crate::rlop::AlwaysReadyScheduler;

fn parse_gameexe(text: &str) -> Gameexe {
    let bytes = encoding_rs::SHIFT_JIS.encode(text).0.into_owned();
    Gameexe::parse(&bytes).expect("synthetic gameexe must parse")
}

// Synthetic § H route shape used by the unit tests. Deliberately
// authored at an 800x600 screen (NOT any staged corpus resolution)
// with a right-edge hot region, so the pointer round-trip proves the
// dispatcher works at whatever screen size the game declares — the
// geometry is driven by `SCREENSIZE_MOD`, never a baked-in canvas.
const SCREEN_W: u32 = 800;
const SCREEN_H: u32 = 600;
const SCREENSIZE_LINE: &str = "#SCREENSIZE_MOD=1,800,600\r\n";

fn reallive_real_bytes_lines_14_28() -> &'static str {
    // The § H syscall route prefix; the dispatcher must boot against
    // it without an unrelated SEEN_START / CAPTION sidecar.
    concat!(
        "#CANCELCALL_MOD=1\r\n",
        "#CANCELCALL=9999,10\r\n",
        "#SYSTEMCALL_SAVE_MOD=1\r\n",
        "#SYSTEMCALL_SAVE=9999,20\r\n",
        "#SYSTEMCALL_LOAD_MOD=1\r\n",
        "#SYSTEMCALL_LOAD=9999,21\r\n",
        "#SYSTEMCALL_SYSTEM_MOD=1\r\n",
        "#SYSTEMCALL_SYSTEM=9999,22\r\n",
        "#MOUSEACTIONCALL.000.MOD=1\r\n",
        "#MOUSEACTIONCALL.000.SEEN=9999,30\r\n",
        "#MOUSEACTIONCALL.000.AREA=752,0,799,599\r\n",
        "#LOADCALL_MOD=1\r\n",
        "#LOADCALL=9999,40\r\n",
        "#EXAFTERCALL_MOD=0\r\n",
        "#EXAFTERCALL=9999,50\r\n",
        "#WBCALL.000=9999,0\r\n",
        "#WBCALL.001=9999,1\r\n",
        "#WBCALL.002=9999,2\r\n",
        "#WBCALL.003=9999,3\r\n",
        "#WBCALL.004=9999,4\r\n",
        "#WBCALL.005=9999,5\r\n",
        "#WBCALL.006=9999,6\r\n",
        "#WBCALL.007=9999,7\r\n",
        "#SCREENSIZE_MOD=1,800,600\r\n",
    )
}

#[path = "syscall_tests/routing.rs"]
mod routing;

#[path = "syscall_tests/validation_and_execution.rs"]
mod validation_and_execution;
