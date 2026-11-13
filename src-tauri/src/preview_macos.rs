//! Short-lived native renderer, shared by Desktop and the preview/MCP helper.
//! All networking uses the existing public-only, DNS-pinned proxy. No Safari
//! process/profile, developer PATH, shell, remote debugging or bundled browser.
use super::PublicProxy;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

struct OwnedRenderer(Child);
impl OwnedRenderer {
    fn terminate(&mut self) {
        if matches!(self.0.try_wait(), Ok(Some(_))) {
            return;
        }
        // Give AppKit/WebKit a bounded normal termination path. SIGKILL alone
        // bypasses WebKit's prewarm cleanup; use it only if the renderer is stuck.
        unsafe {
            libc::kill(self.0.id() as libc::pid_t, libc::SIGTERM);
        }
        let until = Instant::now() + Duration::from_millis(350);
        while Instant::now() < until {
            if matches!(self.0.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Drop for OwnedRenderer {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn run(request: Value, stop: &AtomicBool, deadline: Instant) -> Result<Value, String> {
    if stop.load(Ordering::Relaxed) {
        return Err("Capture cancelled.".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable
        .parent()
        .ok_or("The native renderer is unavailable.")?;
    #[cfg(test)]
    let directory = if directory.file_name().is_some_and(|name| name == "deps") {
        directory.parent().unwrap_or(directory)
    } else {
        directory
    };
    let relative = "StashDockRenderer.app/Contents/MacOS/stashdock-render";
    let helper = [
        directory.join("../Helpers").join(relative),
        directory.join(relative),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .ok_or("The native renderer is unavailable. Reinstall StashDock.")?;
    let permit = super::admission::acquire(stop, deadline).map_err(|error| {
        // Admission shares the request's original deadline and cancellation;
        // waiting for another host must retain the renderer's public errors.
        if stop.load(Ordering::Relaxed) { "Capture cancelled.".into() }
        else if Instant::now() >= deadline { "Screenshot timed out.".into() }
        else { error }
    })?;
    let mut command = Command::new(helper);
    permit.inherit(&mut command);
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for key in ["HOME", "TMPDIR", "LANG"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = OwnedRenderer(
        command
            .spawn()
            .map_err(|_| "The native renderer is unavailable. Reinstall StashDock.")?,
    );
    let mut input = child
        .0
        .stdin
        .take()
        .ok_or("The renderer input is unavailable.")?;
    let output = child
        .0
        .stdout
        .take()
        .ok_or("The renderer output is unavailable.")?;
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    let writer = thread::spawn(move || input.write_all(&bytes));
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .take(5_000_001)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let status = loop {
        if stop.load(Ordering::Relaxed) || Instant::now() >= deadline {
            child.terminate();
            let _ = writer.join();
            let _ = reader.join();
            return Err(if stop.load(Ordering::Relaxed) {
                "Capture cancelled."
            } else {
                "Screenshot timed out."
            }
            .into());
        }
        match child.0.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => {
                child.terminate();
                let _ = writer.join();
                let _ = reader.join();
                return Err("The native renderer stopped.".into());
            }
        }
    };
    writer
        .join()
        .map_err(|_| "The renderer input failed.")?
        .map_err(|_| "The renderer input failed.")?;
    let bytes = reader
        .join()
        .map_err(|_| "The renderer output failed.")?
        .map_err(|_| "The renderer output failed.")?;
    if !status.success() || bytes.len() > 5_000_000 {
        return Err("The native renderer failed.".into());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The native renderer returned an invalid result.")?;
    if let Some(error) = value["error"].as_str() {
        return Err(error.to_owned());
    }
    let preview = value["preview"]
        .as_str()
        .filter(|s| s.starts_with("data:image/jpeg;base64,"))
        .ok_or("The native renderer did not return a screenshot.")?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(preview.split_once(',').unwrap().1)
        .map_err(|_| "Invalid screenshot data.")?;
    let image = image::load_from_memory(&bytes).map_err(|_| "Invalid screenshot image.")?;
    if image.width() != 1280 || image.height() != 800 {
        return Err("Invalid screenshot dimensions.".into());
    }
    Ok(value)
}
pub(super) fn capture(
    url: &str,
    stop: &AtomicBool,
    deadline: Instant,
) -> Result<super::Rendered, String> {
    if stop.load(Ordering::Relaxed) {
        return Err("Capture cancelled.".into());
    }
    let parsed = crate::public_web::web_url(url)?;
    if !matches!(parsed.host(), Some(url::Host::Domain(_))) {
        return Err("Automatic Mac previews require a public domain name.".into());
    }
    let proxy = PublicProxy::start(deadline)?;
    let value = run(
        json!({"url":url,"proxyPort":proxy.address.port()}),
        stop,
        deadline,
    )?;
    let extracted = value["html"]
        .as_str()
        .map(|html| crate::link_metadata::extract_preview(html, &parsed));
    Ok(super::Rendered {
        image: value["preview"].as_str().map(str::to_owned),
        title: extracted
            .as_ref()
            .map(|page| page.title.clone())
            .unwrap_or_default(),
        content: extracted.map(|page| page.content).unwrap_or_default(),
    })
}
pub(super) fn read_pdf(
    bytes: &[u8],
    stop: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    use base64::Engine;
    // PDFKit renders supplied bytes without a URL, web view or network session.
    run(
        json!({"pdf":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        stop,
        deadline,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    fn header(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        while bytes.len() < 16384 && !bytes.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                break;
            }
            bytes.push(byte[0]);
        }
        bytes
    }
    struct Fixture {
        proxy: std::net::SocketAddr,
        private: TcpListener,
        paths: Arc<Mutex<Vec<String>>>,
        targets: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        tasks: Vec<thread::JoinHandle<()>>,
    }
    impl Fixture {
        fn new() -> Self {
            Self::with_socks(false)
        }
        fn with_socks(socks: bool) -> Self {
            let private = TcpListener::bind("127.0.0.1:0").unwrap();
            private.set_nonblocking(true).unwrap();
            let port = private.local_addr().unwrap().port();
            let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
            upstream.set_nonblocking(true).unwrap();
            let upstream_address = upstream.local_addr().unwrap();
            let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
            proxy.set_nonblocking(true).unwrap();
            let address = proxy.local_addr().unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let paths = Arc::new(Mutex::new(Vec::new()));
            let done = stop.clone();
            let seen = paths.clone();
            let upstream_task = thread::spawn(move || {
                let mut requests = Vec::new();
                while !done.load(Ordering::Relaxed) {
                    if let Ok((mut stream, _)) = upstream.accept() {
                        stream.set_nonblocking(false).unwrap();
                        let seen = seen.clone();
                        requests.push(thread::spawn(move || {
                            if socks {
                                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                                let mut greeting = [0; 3];
                                stream.read_exact(&mut greeting).unwrap();
                                assert_eq!(greeting, [5, 1, 0]);
                                stream.write_all(&[5, 0]).unwrap();
                                let mut prefix = [0; 4];
                                stream.read_exact(&mut prefix).unwrap();
                                assert_eq!(&prefix[..3], &[5, 1, 0]);
                                let host = match prefix[3] {
                                    1 => { let mut ip = [0; 4]; stream.read_exact(&mut ip).unwrap(); std::net::Ipv4Addr::from(ip).to_string() },
                                    3 => { let mut len = [0]; stream.read_exact(&mut len).unwrap(); let mut name = vec![0; len[0] as usize]; stream.read_exact(&mut name).unwrap(); String::from_utf8(name).unwrap() },
                                    _ => panic!("Unexpected SOCKS destination"),
                                };
                                assert!(host == "example.org" || host.parse().is_ok_and(crate::public_web::public_ip));
                                let mut port = [0; 2];
                                stream.read_exact(&mut port).unwrap();
                                assert_eq!(u16::from_be_bytes(port), 80);
                                stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).unwrap();
                            } else {
                            let request = header(&mut stream);
                            let first = String::from_utf8_lossy(&request).lines().next().unwrap_or("").to_owned();
                            // The trusted OS proxy receives the checked public destination by name.
                            let target = url::Url::parse(&format!("http://{}", first.split_whitespace().nth(1).unwrap())).unwrap();
                            assert!(target.host_str() == Some("example.org") || target.host_str().and_then(|s| s.parse().ok()).is_some_and(crate::public_web::public_ip));
                            assert_eq!(target.port_or_known_default(), Some(80));
                            stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").unwrap();
                            }
                            let request = header(&mut stream);
                            let path = String::from_utf8_lossy(&request).split_whitespace().nth(1).unwrap_or("").to_owned();
                            seen.lock().unwrap().push(path.clone());
                            let (status, extra, content_type, body) = if path == "/settling" {
                                ("200 OK", String::new(), "text/html", "<!doctype html><style>body{margin:0;background:rgb(170,170,170);animation:paint 1.4s steps(1,end) forwards}h1{opacity:0;animation:show 1.4s steps(1,end) forwards}@keyframes paint{to{background:rgb(33,113,191)}}@keyframes show{to{opacity:1}}</style><h1>Late visible article</h1>".to_string())
                            } else if path == "/overlay" {
                                ("200 OK", String::new(), "text/html", "<!doctype html><style>body{margin:0;background:rgb(170,170,170)}#cover{position:fixed;inset:0;z-index:100;background:rgb(170,170,170)}</style><nav>Small menu</nav><main><h1>Complete article underneath the loading layer</h1><p>This meaningful article must not be captured while its full viewport loading layer still obscures all of the actual reference content.</p></main><div id='cover'><svg width='320' height='200'><rect width='320' height='200' fill='gray'/></svg></div><script>setTimeout(()=>{document.getElementById('cover').remove();document.body.style.background='rgb(33,113,191)'},8200)</script>".to_string())
                            } else if path == "/worker.js" {
                                ("200 OK", String::new(), "application/javascript", format!(r#"fetch('http://127.0.0.1:{port}/worker').catch(()=>{{}});fetch('http://127.0.0.1.nip.io/worker').catch(()=>{{}});try{{new WebSocket('ws://127.0.0.1:{port}/worker-socket')}}catch{{}};postMessage('ran');"#))
                            } else if path == "/frame" {
                                ("200 OK", String::new(), "text/html", format!(r#"<script>fetch('http://127.0.0.1:{port}/frame-fetch').catch(()=>{{}});parent.postMessage({{frameRtc:typeof RTCPeerConnection}},'*');</script>"#))
                            } else if path == "/blank" {
                                ("200 OK", String::new(), "text/html", "<!doctype html><body style='background:rgb(170,170,170)'></body>".to_string())
                            } else if path == "/style.css" {
                                ("200 OK", String::new(), "text/css", "body{margin:0;background:rgb(33,113,191);color:white}h1{padding:40px}".to_string())
                            } else if path == "/redirect" {
                                ("302 Found", format!("Location: http://127.0.0.1:{port}/secret\r\n"), "text/plain", String::new())
                            } else {
                                ("200 OK", String::new(), "text/html", format!(r#"<!doctype html><html><head><link rel="stylesheet" href="http://example.org/style.css"></head><body><h1>Native isolated screenshot</h1><img src="http://127.0.0.1:{port}/private.png"><iframe src="http://localhost:{port}/private"></iframe><img src="http://127.0.0.1.nip.io/alias.png"><script>
                                document.body.setAttribute('aria-busy','true');document.body.dataset.rtc=typeof RTCPeerConnection;document.body.dataset.sw=typeof navigator.serviceWorker;
                                fetch('http://127.0.0.1:{port}/script').catch(()=>{{}});fetch('http://127.0.0.1.nip.io/fetch').catch(()=>{{}});
                                try{{new WebSocket('ws://127.0.0.1:{port}/socket')}}catch{{}};
                                try{{const x=new XMLHttpRequest();x.open('POST','http://127.0.0.1:{port}/xhr');x.send('capture')}}catch{{}};
                                const worker=new Worker('http://example.org/worker.js');worker.onmessage=()=>document.body.dataset.worker='ran';
                                try{{const dataWorker=new Worker('data:application/javascript,'+encodeURIComponent("fetch('http://127.0.0.1:{port}/data-worker').catch(()=>{{}});postMessage('ran')"));dataWorker.onmessage=()=>document.body.dataset.dataWorker='ran';dataWorker.onerror=()=>document.body.dataset.dataWorker='blocked'}}catch{{document.body.dataset.dataWorker='blocked'}};
                                addEventListener('message',e=>{{if(e.data?.frameRtc)document.body.dataset.frameRtc=e.data.frameRtc}});
                                requestAnimationFrame(()=>requestAnimationFrame(()=>document.body.dataset.animation='ran'));
                                setTimeout(()=>{{document.body.style.background='red';document.body.removeAttribute('aria-busy')}},1600);
                                </script><iframe src="http://example.org/frame"></iframe></body></html>"#))
                            };
                            let response = format!("HTTP/1.1 {status}\r\n{extra}Content-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = stream.write_all(response.as_bytes());
                        }));
                    } else {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
                for request in requests {
                    request.join().unwrap();
                }
            });
            let done = stop.clone();
            let targets = Arc::new(Mutex::new(Vec::new()));
            let target_records = targets.clone();
            let proxy_task = thread::spawn(move || {
                let mut connections = Vec::new();
                while !done.load(Ordering::Relaxed) {
                    if let Ok((stream, _)) = proxy.accept() {
                        let stop = done.clone();
                        let targets = target_records.clone();
                        connections.push(thread::spawn(move || {
                            stream.set_nonblocking(false).unwrap();
                            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                            let mut peek = [0u8; 512];
                            let n = stream.peek(&mut peek).unwrap_or(0);
                            if let Some(target) = String::from_utf8_lossy(&peek[..n]).split_whitespace().nth(1) { targets.lock().unwrap().push(target.to_owned()); }
                            if let Ok(mut error) = stream.try_clone() {
                                let settings = if socks { crate::public_web::SystemProxy::default().with_socks5(upstream_address) } else { crate::public_web::SystemProxy::new(Some(upstream_address), "") };
                                if super::super::proxy_connection(stream, stop, Arc::new(std::sync::atomic::AtomicUsize::new(0)), Instant::now()+Duration::from_secs(12), 24*1024*1024, settings).is_err() {
                                    let _ = error.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                }
                            }
                        }));
                    } else {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
                for connection in connections {
                    connection.join().unwrap();
                }
            });
            Self {
                proxy: address,
                private,
                paths,
                targets,
                stop,
                tasks: vec![upstream_task, proxy_task],
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            for task in self.tasks.drain(..) {
                let _ = task.join(); // Never double-panic while cleaning up a failed assertion.
            }
        }
    }

    #[test]
    fn proxy_tunnel_waits_for_fragmented_requests() {
        let fixture = Fixture::new();
        let mut socket = TcpStream::connect(fixture.proxy).unwrap();
        socket
            .write_all(b"CONNECT 1.1.1.1:80 HTTP/1.1\r\nHost: ")
            .unwrap();
        thread::sleep(Duration::from_millis(30));
        socket.write_all(b"1.1.1.1:80\r\n\r\n").unwrap();
        let response = header(&mut socket);
        assert!(
            String::from_utf8_lossy(&response).contains("200 Connection"),
            "{:?}",
            response
        );
        socket
            .write_all(b"GET /style.css HTTP/1.1\r\nHost: 1.1.1.1\r\n\r\n")
            .unwrap();
        let response = header(&mut socket);
        assert!(
            String::from_utf8_lossy(&response).contains("200 OK"),
            "{:?}",
            response
        );
        assert!(String::from_utf8_lossy(&response).contains("text/css"));
        assert!(fixture
            .paths
            .lock()
            .unwrap()
            .iter()
            .any(|p| p == "/style.css"));
    }

    #[test]
    #[ignore = "runs native WebKit in an isolated controlled network fixture"]
    fn native_webkit_routes_resources_and_redirects_through_public_guard() {
        verify_native_guard(Fixture::new());
    }

    #[test]
    #[ignore = "runs native WebKit through a controlled SOCKS5 fixture"]
    fn native_webkit_socks_resources_keep_the_same_public_guard() {
        verify_native_guard(Fixture::with_socks(true));
    }

    #[test]
    #[ignore = "runs native WebKit with a delayed first meaningful paint"]
    fn native_webkit_waits_for_visible_stable_content() {
        use base64::Engine;
        let fixture = Fixture::new();
        let result = run(json!({"url":"http://example.org/settling","proxyPort":fixture.proxy.port()}), &AtomicBool::new(false), Instant::now()+Duration::from_secs(10)).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(result["preview"].as_str().unwrap().split_once(',').unwrap().1).unwrap();
        let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
        let pixel = image.get_pixel(1100,700).0;
        assert!(pixel[0]<45 && (100..125).contains(&pixel[1]) && (180..205).contains(&pixel[2]), "captured unfinished gray frame: {pixel:?}");
    }

    #[test]
    #[ignore = "runs native WebKit with a permanently empty gray page"]
    fn native_webkit_never_accepts_a_blank_gray_page() {
        let fixture = Fixture::new();
        let started = Instant::now();
        assert!(run(json!({"url":"http://example.org/blank","proxyPort":fixture.proxy.port()}), &AtomicBool::new(false), started+Duration::from_secs(12)).is_err(), "a blank gray frame must not be a successful cover");
        assert!(started.elapsed() < Duration::from_secs(11), "a stagnant gray page must stop at the quality budget, before the owner's hard timeout");
    }

    #[test]
    #[ignore = "runs native WebKit with a script-owned full-viewport loader"]
    fn native_webkit_waits_until_the_loading_layer_reveals_the_article() {
        use base64::Engine;
        let fixture = Fixture::new();
        let result = run(json!({"url":"http://example.org/overlay","proxyPort":fixture.proxy.port()}), &AtomicBool::new(false), Instant::now()+Duration::from_secs(14)).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(result["preview"].as_str().unwrap().split_once(',').unwrap().1).unwrap();
        let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
        let pixel = image.get_pixel(1100,700).0;
        assert!(pixel[0]<45 && (100..125).contains(&pixel[1]) && (180..205).contains(&pixel[2]), "captured the loader instead of the article: {pixel:?}");
        assert!(!result["html"].as_str().unwrap().contains("id=\"cover\""), "capture must follow the website's own loader dismissal");
    }

    fn verify_native_guard(fixture: Fixture) {
        let result = run(
            json!({"url":"http://example.org/page","proxyPort":fixture.proxy.port()}),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(15),
        );
        assert!(
            fixture.private.accept().is_err(),
            "WebKit bypassed the proxy for a loopback resource"
        );
        let result = result.unwrap();
        let html = result["html"]
            .as_str()
            .expect("The same render returns its bounded HTML");
        let page = crate::link_metadata::extract_preview(
            html,
            &url::Url::parse("http://example.org/page").unwrap(),
        );
        assert!(page.content.contains("Native isolated screenshot"));
        for attribute in ["data-rtc=\"undefined\"", "data-sw=\"undefined\"", "data-worker=\"ran\"", "data-frame-rtc=\"undefined\"", "data-animation=\"ran\""] {
            assert!(html.contains(attribute), "missing dynamic isolation evidence: {attribute}");
        }
        assert!(html.contains("data-data-worker=\"ran\"") || html.contains("data-data-worker=\"blocked\""), "inline workers must either run under the same network guard or be rejected");
        assert!(
            !page.content.contains("fetch("),
            "script source is not reference content"
        );
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                result["preview"]
                    .as_str()
                    .unwrap()
                    .split_once(',')
                    .unwrap()
                    .1,
            )
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
        let pixel = image.get_pixel(1100, 700).0;
        assert!(
            pixel[0] > 230 && pixel[1] < 20 && pixel[2] < 20,
            "page scripts must paint after the loading state: {pixel:?}"
        );
        assert!(fixture
            .paths
            .lock()
            .unwrap()
            .iter()
            .any(|path| path == "/style.css"));
        assert!(
            fixture.private.accept().is_err(),
            "private subresources/frames must never reach loopback"
        );
        assert!(
            fixture
                .targets
                .lock()
                .unwrap()
                .iter()
                .any(|t| t == "127.0.0.1.nip.io:80"),
            "private DNS alias must go through the guarded proxy, never a direct connection"
        );
        assert!(run(
            json!({"url":"http://example.org/redirect","proxyPort":fixture.proxy.port()}),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(15)
        )
        .is_err());
        assert!(
            fixture.private.accept().is_err(),
            "private redirect must never reach loopback"
        );
    }

    fn pdf_fixture() -> Vec<u8> {
        let content = "BT /F1 24 Tf 72 700 Td (StashDock native PDF fixture) Tj ET";
        let objects = vec!["<< /Type /Catalog /Pages 2 0 R >>".to_owned(), "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(), "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_owned(), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(), format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()), "<< /Title (Native PDF Fixture) >>".to_owned()];
        let mut pdf = "%PDF-1.4\n".to_string();
        let mut offsets = Vec::new();
        for (n, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf += &format!("{} 0 obj\n{object}\nendobj\n", n + 1);
        }
        let xref = pdf.len();
        pdf += "xref\n0 7\n0000000000 65535 f \n";
        for offset in offsets {
            pdf += &format!("{offset:010} 00000 n \n");
        }
        pdf +=
            &format!("trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        pdf.into_bytes()
    }
    #[test]
    #[ignore = "runs native PDFKit on generated fixture bytes"]
    fn native_pdfkit_returns_text_metadata_and_real_first_page() {
        let result = read_pdf(
            &pdf_fixture(),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(result["title"], "Native PDF Fixture");
        assert!(result["content"]
            .as_str()
            .unwrap()
            .contains("StashDock native PDF fixture"));
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                result["preview"]
                    .as_str()
                    .unwrap()
                    .split_once(',')
                    .unwrap()
                    .1,
            )
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert!(
            image
                .pixels()
                .filter(|p| p.0.iter().any(|c| *c < 150))
                .count()
                > 100,
            "rendered PDF text must be visible"
        );
        let destination = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../output/playwright/native-pdf-preview.jpg");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::write(destination, bytes).unwrap();
    }
    #[test]
    #[ignore = "runs native subprocess cancellation and hard deadline checks"]
    fn owned_renderer_cancellation_and_timeout_are_bounded() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = stop.clone();
        let task = thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            cancel.store(true, Ordering::Relaxed);
        });
        let start = Instant::now();
        assert_eq!(
            run(
                json!({"url":"http://example.org/","proxyPort":port}),
                &stop,
                Instant::now() + Duration::from_secs(10)
            )
            .unwrap_err(),
            "Capture cancelled."
        );
        task.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(3));
        let start = Instant::now();
        assert_eq!(
            run(
                json!({"url":"http://example.org/","proxyPort":port}),
                &AtomicBool::new(false),
                Instant::now() + Duration::from_millis(400)
            )
            .unwrap_err(),
            "Screenshot timed out."
        );
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
