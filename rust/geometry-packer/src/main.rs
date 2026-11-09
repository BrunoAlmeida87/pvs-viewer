//! Packs one already parsed geometry chunk into the viewer's existing binary format.
//! See README.md for the input protocol. No external crates are required.
use std::env;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};

const MAX_VERTICES: usize = 65_535;
const MAX_ELEMENTS: usize = 100_000_000;

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn read_u32(input: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; 4];
    input.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_array(input: &mut impl Read, count: usize, width: usize) -> io::Result<Vec<u8>> {
    let len = count.checked_mul(width).ok_or_else(|| invalid("length overflow"))?;
    let mut bytes = vec![0; len];
    input.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn pack(mut input: impl Read, mut output: impl Write) -> io::Result<([f64; 3], [f64; 3], usize)> {
    let mut magic = [0; 4];
    input.read_exact(&mut magic)?;
    if &magic != b"PVP1" { return Err(invalid("invalid input magic")); }
    let nv = read_u32(&mut input)? as usize;
    let ni = read_u32(&mut input)? as usize;
    let ne = read_u32(&mut input)? as usize;
    if nv == 0 || nv > MAX_VERTICES || ni > MAX_ELEMENTS || ne > MAX_ELEMENTS || ni % 3 != 0 || ne % 2 != 0 {
        return Err(invalid("invalid geometry counts"));
    }
    let positions = read_array(&mut input, nv, 12)?;
    let normals = read_array(&mut input, nv, 4)?;
    let locals = read_array(&mut input, nv, 2)?;
    let indices = read_array(&mut input, ni, 2)?;
    let edges = read_array(&mut input, ne, 2)?;
    let mut trailing = [0; 1];
    if input.read(&mut trailing)? != 0 { return Err(invalid("trailing input")); }

    for array in [&indices, &edges] {
        for pair in array.chunks_exact(2) {
            if u16::from_le_bytes([pair[0], pair[1]]) as usize >= nv {
                return Err(invalid("index outside vertex array"));
            }
        }
    }
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    let mut coordinates = Vec::with_capacity(nv);
    for vertex in positions.chunks_exact(12) {
        let mut xyz = [0.0; 3];
        for axis in 0..3 {
            let offset = axis * 4;
            let value = f32::from_le_bytes(vertex[offset..offset + 4].try_into().unwrap()) as f64;
            if !value.is_finite() { return Err(invalid("non-finite coordinate")); }
            xyz[axis] = value;
            low[axis] = low[axis].min(value);
            high[axis] = high[axis].max(value);
        }
        coordinates.push(xyz);
    }
    for (index, xyz) in coordinates.iter().enumerate() {
        for axis in 0..3 {
            let extent = (high[axis] - low[axis]).max(1e-6);
            let value = ((xyz[axis] - low[axis]) / extent * 65_535.0)
                .round_ties_even().clamp(0.0, 65_535.0) as u16;
            output.write_all(&value.to_le_bytes())?;
        }
        output.write_all(&locals[index * 2..index * 2 + 2])?;
    }
    output.write_all(&normals)?;
    output.write_all(&indices)?;
    output.write_all(&edges)?;
    Ok((low, high, nv * 12 + ni * 2 + ne * 2))
}

fn main() -> io::Result<()> {
    let mut args = env::args().skip(1);
    let (Some(input), Some(output), None) = (args.next(), args.next(), args.next()) else {
        eprintln!("Uso: pvs-geometry-packer <entrada.pvp1> <saida.bin>");
        std::process::exit(2);
    };
    let input = BufReader::new(File::open(input)?);
    let mut output = BufWriter::new(File::create(output)?);
    let (low, high, bytes) = pack(input, &mut output)?;
    output.flush()?;
    println!("{{\"min\":{:?},\"max\":{:?},\"bytes\":{bytes}}}", low, high);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_viewer_layout() {
        let mut input = b"PVP1".to_vec();
        for n in [2_u32, 0, 0] { input.extend(n.to_le_bytes()); }
        for n in [0.0_f32, 0.0, 0.0, 1.0, 2.0, 3.0] { input.extend(n.to_le_bytes()); }
        input.extend([0_u8; 8]);
        input.extend([0_u8, 0, 1, 0]);
        let mut output = Vec::new();
        let (low, high, bytes) = pack(&input[..], &mut output).unwrap();
        assert_eq!(low, [0.0; 3]);
        assert_eq!(high, [1.0, 2.0, 3.0]);
        assert_eq!(bytes, 24);
        assert_eq!(&output[..8], &[0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&output[8..16], &[255, 255, 255, 255, 255, 255, 1, 0]);
    }

    #[test]
    fn rejects_invalid_index() {
        let mut input = b"PVP1".to_vec();
        for n in [1_u32, 3, 0] { input.extend(n.to_le_bytes()); }
        input.extend([0_u8; 12 + 4 + 2]);
        for n in [0_u16, 1, 0] { input.extend(n.to_le_bytes()); }
        assert_eq!(pack(&input[..], Vec::new()).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
}

