use super::*;

pub(super) fn container_as_str(container: ContainerTransform) -> &'static str {
    match container {
        ContainerTransform::Identity => "identity",
        ContainerTransform::Directory => "directory",
        ContainerTransform::LooseFile => "loose_file",
        ContainerTransform::ProjectAsset => "project_asset",
        ContainerTransform::Archive => "archive",
        ContainerTransform::Xp3 => "xp3",
        ContainerTransform::SiglusPck => "siglus_pck",
        ContainerTransform::Rgssad => "rgssad",
        ContainerTransform::WolfArchive => "wolf_archive",
        ContainerTransform::AssetBundle => "asset_bundle",
        ContainerTransform::Unknown => "unknown",
    }
}

pub(super) fn codec_as_str(codec: CodecTransform) -> &'static str {
    match codec {
        CodecTransform::Identity => "identity",
        CodecTransform::PngImage => "png_image",
        CodecTransform::M4aAudio => "m4a_audio",
        CodecTransform::OggAudio => "ogg_audio",
        CodecTransform::Utf8Text => "utf8_text",
        CodecTransform::Utf16Text => "utf16_text",
        CodecTransform::ShiftJisText => "shift_jis_text",
        CodecTransform::JsonText => "json_text",
        CodecTransform::RpgMakerMvMzJson => "rpg_maker_mv_mz_json",
        CodecTransform::TyranoScriptMarkup => "tyrano_script_markup",
        CodecTransform::RubyMarshal => "ruby_marshal",
        CodecTransform::BytecodeDecompile => "bytecode_decompile",
        CodecTransform::BinaryTable => "binary_table",
        CodecTransform::Unknown => "unknown",
    }
}

pub(super) fn surface_as_str(surface: SurfaceTransform) -> &'static str {
    match surface {
        SurfaceTransform::Identity => "identity",
        SurfaceTransform::JsonPointer => "json_pointer",
        SurfaceTransform::ArchiveEntry => "archive_entry",
        SurfaceTransform::BinaryOffset => "binary_offset",
        SurfaceTransform::TableRecord => "table_record",
        SurfaceTransform::RuntimeTrace => "runtime_trace",
        SurfaceTransform::OcrRegion => "ocr_region",
        SurfaceTransform::Unknown => "unknown",
    }
}
