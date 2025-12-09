---
title: "[Troubleshooting] Nginx로 HTTPS→HTTP 프록시 구성해 Mixed Content 해결하기 (도메인 없이 nip.io 사용)"
date: 2025-12-09 14:46:00 +0900
tags:
  - trouble shooting
  - nginx
  - https
  - nip.io
  - docker
  - devops
  - ssl
  - ec2
  - aws
thumbnail: "/assets/img/thumbnail/nginx-https-without-domain-nip-io.png"
---

# Nginx로 HTTPS→HTTP 프록시 구성해 Mixed Content 해결하기

## 1. 문제 상황

현재 개발 중인 프로젝트의 아키텍처는 프론트엔드와 백엔드가 분리되어 있다. 프론트엔드는 HTTPS 환경(Vercel, Netlify 등)에서 배포되었으나, 백엔드 API 서버는 AWS EC2 상에서 컨테이너(Spring Boot)로 띄워져 있으며 HTTP(8080) 포트만 열려 있는 상태다.

브라우저의 보안 정책(Mixed Content)으로 인해 **HTTPS 사이트에서 HTTP 리소스를 요청할 경우 보안 연결이 안전하지 않다는 이유로 요청이 차단**된다. 도메인을 구매하지 않은 개발 단계에서는 이 문제를 해결하기 위해 EC2 앞단에 Nginx를 두고 SSL 인증서를 적용하여 HTTPS 통신을 지원하도록 구성했다.

## 2. 해결 전략 및 아키텍처

핵심은 **SSL Termination(SSL 종료)** 방식이다. 클라이언트와의 통신은 HTTPS로 암호화하고, 내부 서버(Spring Boot)와의 통신은 HTTP로 처리한다. 이를 위해 리버스 프록시(Reverse Proxy)인 Nginx를 사용했다.

- Nginx를 앞단에 두는 경우 보안 그룹에서 **8080은 외부에 열지 않고** 80/443만 공개하는 구성이 권장된다.
- 이 글에서는 관용적으로 SSL이라고 표현하지만 실제 표준은 TLS이다.

일반적인 무료 CA(Let’s Encrypt)는 **IP 주소 SAN 인증서를 지원하지 않는다.**

그래서 개발 단계에서는 nip.io 같은 DNS 서비스로 도메인처럼 검증 가능한 형태를 만든다.

<img width="1266" height="200" alt="image" src="https://github.com/user-attachments/assets/2e8d46f8-1b97-452a-b49a-72c53bec0922" />


## 3. 주요 개념 설명

### 1) SSL Termination (SSL 종료)

우리의 목표는 EC2 내부의 Spring Boot까지 HTTPS로 연결하는 것이 아니다. **"보안이 필요한 구간까지만 암호화하고, 안전한 내부망에서는 속도를 위해 평문으로 통신하는 것"**, 이것이 바로 **SSL Termination**이다.

- **동작 원리:** 클라이언트(브라우저)와 Nginx 사이의 '공개된 인터넷 구간'은 HTTPS로 암호화하여 데이터를 보호한다. 하지만 Nginx가 패킷을 받아 복호화(Decryption)를 마친 후, 뒤단에 있는 Spring Boot에게는 HTTP(평문)로 데이터를 전달한다.
- **장점:** 암호화/복호화는 CPU 연산 비용이 비싼 작업이다. 이를 Nginx가 전담하게 함으로써, 백엔드 서버(Spring Boot)는 비즈니스 로직 처리에만 집중할 수 있어 전체적인 서버 부하를 줄일 수 있다.

### 2) 리버스 프록시 (Reverse Proxy)

클라이언트가 서버에 직접 접근하는 것을 막고, 중간에서 대리인 역할을 하는 서버를 말한다.

- **Forward Proxy vs Reverse Proxy:** 사용자가 인터넷에 나갈 때 대신 나가주는 것이 포워드 프록시라면, 외부의 요청이 내부 서버로 들어올 때 받아주는 문지기가 리버스 프록시다.
- **사용 이유:**
    - **보안:** 실제 WAS(Spring Boot)의 포트나 IP를 외부에 노출하지 않고 숨길 수 있다.
    - **로드 밸런싱:** 트래픽이 많아질 경우 Nginx 뒤에 여러 대의 WAS를 두어 부하를 분산시킬 수 있다.
    - **HTTPS 적용 용이:** WAS마다 인증서를 설정하는 번거로움 없이, 앞단의 프록시 서버 한 곳에서만 인증서를 관리하면 된다.

### 3) 왜 IP 주소에는 SSL 인증서 발급이 안 될까?

보통 SSL 인증서는 `google.com` 같은 **도메인 이름(Domain Name)**을 기준으로 발급된다. 기술적으로 IP 주소에 인증서를 발급하는 것(Public IP Certificate)이 불가능한 것은 아니지만, 다음과 같은 이유로 일반적인 무료 인증기관(Let's Encrypt 등)에서는 지원하지 않는다.

1. **소유권 증명의 어려움:** 도메인은 DNS 레코드를 통해 소유권을 명확히 증명할 수 있다. 반면 IP 주소, 특히 클라우드 환경의 유동 IP는 언제든 주인이 바뀔 수 있어 소유권을 지속적으로 보장하기 어렵다.
2. **신뢰성 문제:** 피싱 사이트들이 도메인 없이 IP로만 접근하도록 유도하는 경우가 많아, 보안 관점에서 IP 주소에 대한 인증서 발급은 매우 까다로운 검증 절차(OV/EV 등급)를 거쳐야 하며 비용이 비싸다.
    - *따라서 우리는 IP 주소를 도메인처럼 해석해주는 `nip.io`를 사용하여, 인증기관이 이를 '도메인'으로 인식하게 만드는 우회 전략을 사용하는 것이다.*

### 4) Let's Encrypt & Certbot

- **Let's Encrypt:** 전 세계 웹의 보안 향상을 목표로 하는 비영리 인증 기관(CA)이다. 복잡하고 비싼 기존의 인증서 발급 절차를 자동화하고 무료로 제공하여 HTTPS 보급화에 기여했다.
- **Certbot:** Let's Encrypt 인증서를 자동으로 발급받고 갱신해주는 클라이언트 도구다. Nginx 플러그인을 사용하면 인증서 발급뿐만 아니라 Nginx 설정 파일까지 자동으로 수정해주어(예: 443 포트 리스닝 설정, 인증서 경로 주입 등) 구축 난이도를 대폭 낮춰준다.
- **Reverse Proxy (Nginx):** 클라이언트의 요청을 대신 받아 내부 서버로 전달하고, 내부 서버의 응답을 다시 클라이언트에게 반환하는 서버. 보안 강화 및 부하 분산 목적으로 사용된다.
- **nip.io:** 특정 IP 주소를 서브 도메인으로 포함하면 해당 IP로 DNS를 해석해주는 무료 매직 도메인 서비스다. (예: `52.79.47.44.nip.io` → `52.79.47.44`)
- **Let's Encrypt (Certbot):** 사용자에게 무료로 TLS/SSL 인증서를 발급해주는 비영리 인증 기관(CA)이며, Certbot은 이를 자동화하는 클라이언트 소프트웨어다.

---

## 4. 구축 과정

### Step 1. AWS 보안 그룹(Security Group) 설정

Nginx가 외부 요청을 받을 수 있도록 EC2 보안 그룹의 인바운드 규칙을 수정한다.

- **HTTP (80):** 0.0.0.0/0 허용 (Certbot 인증 및 리다이렉트용)
- **HTTPS (443):** 0.0.0.0/0 허용 (API 통신용)

### Step 2. Nginx 및 Certbot 설치

EC2(Ubuntu 환경 기준)에 접속하여 필요한 패키지를 설치한다.

```bash
sudo apt update
sudo apt install nginx -y
# certbot과 nginx 플러그인 동시 설치
sudo apt install certbot python3-certbot-nginx -y
```

### Step 3. SSL 인증서 발급

`nip.io`를 활용해 도메인을 확정하고 인증서를 발급받는다. 내 EC2 elastic IP가 `52.79.47.44`이므로 도메인은 `52.79.47.44.nip.io`가 된다.

```bash
# Nginx 플러그인을 사용하여 인증서 발급 시도
sudo certbot --nginx -d 52.79.47.44.nip.io
```

- 이메일 입력 및 약관 동의 절차를 진행한다.
- 성공 시 `/etc/letsencrypt/live/...` 경로에 인증서 키가 생성된다.

### Step 4. Nginx 설정 (Reverse Proxy)

Certbot이 기본 설정을 일부 수정했겠지만, 백엔드(Spring Boot)로 트래픽을 넘겨주는 프록시 설정은 직접 작성해야 한다.
`/etc/nginx/sites-available/default` 파일을 열어 수정했다.

```bash
# 1. HTTP 요청을 HTTPS로 강제 리다이렉트
server {
    if ($host = 52.79.47.44.nip.io) {
        return 301 https://$host$request_uri;
    } 

    listen 80 default_server;
    listen [::]:80 default_server;
    server_name 52.79.47.44.nip.io;
    return 404; 
}

# 2. HTTPS 설정 및 리버스 프록시 구성
server {
    # SSL 포트(443) 리스닝
    listen 443 ssl; 
    listen [::]:443 ssl ipv6only=on; 
    server_name 52.79.47.44.nip.io; 

    # Certbot에 의해 관리되는 SSL 인증서 경로
    ssl_certificate /etc/letsencrypt/live/52.79.47.44.nip.io/fullchain.pem; 
    ssl_certificate_key /etc/letsencrypt/live/52.79.47.44.nip.io/privkey.pem; 
    include /etc/letsencrypt/options-ssl-nginx.conf; 
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; 

    # [핵심] 루트 경로(/)로 들어오는 요청을 백엔드로 전달
    location / {
        # 내부의 8080 포트(Spring Boot)로 트래픽 전달
        proxy_pass http://localhost:8080;

        # 백엔드 서버가 클라이언트의 실제 정보를 알 수 있도록 헤더 설정
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 타임아웃 설정 (대용량 요청 등을 대비해 60초 설정)
        proxy_connect_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

### Step 5. 설정 검증 및 재시작

설정 파일 문법에 오류가 없는지 확인 후 Nginx를 재시작하여 적용한다.

```bash
# 문법 검사 (successful 메시지 확인 필수)
sudo nginx -t

# 서비스 재시작
sudo service nginx restart
```

### Step 6. Spring Boot 쪽 설정

Spring에서 올바르게 해석하도록 `application-prod.yml` 파일에 다음 설정을 추가한다

```yaml
server:
	forward-headers-strategy: framework
```

이걸 넣으면

- Swagger/리다이렉트/절대 URL 생성 시
- http/https 혼동 문제를 예방할 수 있다.

---

## 5. 결과 확인

이제 프론트엔드 코드에서 API 호출 주소를 다음과 같이 변경한다.

- 기존: `http://52.79.47.44:8080`
- 변경: **`https://52.79.47.44.nip.io`**

브라우저 네트워크 탭을 확인하면 HTTPS로 정상 통신되며, 443 포트로 들어온 요청이 EC2 내부의 8080 포트로 포워딩되어 정상적인 응답을 받는 것을 확인할 수 있다. 이를 통해 도메인 구매 비용 없이 안전한 개발 환경을 구축하였다.

이 다음부터는 문제를 해결하면서 깊게 공부한 내용들이다.

## 6. 그렇다면 Nginx가 사용자 요청을 받을 때마다 매번 검증하는 것인가?

아니다. Certbot은 인증서를 발급/갱신할 때만 일회성으로 동작하고 종료된다.

이후 통신은 Nginx가 받아놓은 인증서 파일을 가지고 독자적으로 수행한다.

Certbot이 인증서를 받아오는 과정을 ACME(Automatic Certificate Management Environment) 프로토콜이라고 하며, 그 중 우리가 사용한 방식은 HTTP-01 Challenge 방식이다.

### Certbot과 Let’s Encrypt의 동작 원리(HTTP-01 Challenge)

Nginx가 인증을 수행하는 것이 아닌, Certbot(에이전트)과 Let’s Encrypt(인증기관, CA)사이의 숙제 검사 과정을 통해 이루어진다.

```bash
# Nginx 플러그인을 사용하여 인증서 발급 시도
sudo certbot --nginx -d 52.79.47.44.nip.io
```

밑의 과정은 위의 명령어를 쳤을 때 일어나는 일이다.

<img width="773" height="886" alt="image" src="https://github.com/user-attachments/assets/738a14b8-9608-4fe5-b455-a67e94f98828" />


1. **요청 (Request):** EC2에 설치된 Certbot이 Let's Encrypt 서버에 [52.79.47.44.nip.io](http://52.79.47.44.nip.io) 도메인 인증서를 발급해달라고 요청한다.
2. **챌린지 (Challenge):** Let's Encrypt는 도메인 소유권을 확인하기 위해 문제를 낸다. "특정 파일 경로(`/.well-known/acme-challenge/...`)에 우리가 지정한 랜덤 데이터를 심어놔라"고 지시한다.
3. **수행 (Provisioning):** Certbot은 Nginx 설정을 잠시 건드려서, 외부에서 저 경로로 들어왔을 때 해당 데이터를 보여주도록 만든다. (이 과정 때문에 80번 포트가 열려 있어야 한다.)
4. **검증 (Validation):** Let's Encrypt 서버가 인터넷을 통해 해당 주소로 **HTTP 요청**을 날린다. 만약 올바른 데이터가 응답으로 오면 "아, 이 서버가 도메인을 실제로 관리하고 있구나"라고 판단한다.
5. **발급 (Issuance):** 검증이 끝나면 인증서 파일(pubkey, privkey, chain 등)을 내려준다. Certbot은 이를 `/etc/letsencrypt/live/` 경로에 저장하고 Nginx 설정을 업데이트한다.

## 7. 브라우저와 Nginx의 TLS 통신 분석하기

TLS 통신은 데이터를 주고받기 전에 핸드쉐이크(Handshake) 과정을 통해 신뢰할 수 있는 서버인지 확인하고, 데이터를 암호화할 대칭키를 교환한다.

<img width="579" height="875" alt="image" src="https://github.com/user-attachments/assets/0d2cefd2-f618-4605-bcf5-b5b34c616d54" />


1. **Client Hello:** 클라이언트가 서버에 접속하며 자신이 지원하는 암호화 방식(Cipher Suite) 목록과 난수 데이터를 보낸다.
2. **Server Hello & Certificate:** 서버는 클라이언트가 보낸 목록 중 하나를 선택하고, 자신의 신원 증명서인 **SSL 인증서(공개키 포함)(Let’s Encrypt)가 발급하고 디지털 서명(Signature)을 찍어준 파일 원본을** 보낸다.
    - Nginx는 중간에서 인증서를 위조하거나 새로 만드는 것이 아니라, Certbot이 받아온 파일을 그대로 읽어서 클라이언트에게 전달하는 역할만 수행한다.
3. **Certificate Verification:** 클라이언트는 브라우저에 내장된 신뢰할 수 있는 CA(Root Certificate) 목록을 통해 서버가 보낸 인증서가 유효한지 검증한다. 만약 신뢰할 수 없다면 경고창을 띄운다.
    - 검증이 성공하면, 클라이언트는 인증서 내부의 공개키를 꺼낸다.
4. **Key Exchange (비대칭키 암호화 사용):**
    - 클라이언트는 임시 비밀값(Pre-Master Secret)을 생성한다.
    - 이 값을 인증서 안에 있던 **서버의 공개키(Public Key)**로 암호화해서 보낸다.
    - 서버는 자신이 가진 **개인키(Private Key)**로 이것을 복호화한다. (이 과정은 서버만 할 수 있다.)
5. **Session Key Generation:** 클라이언트와 서버는 서로 공유한 비밀값을 바탕으로 실제 데이터 통신에 사용할 **세션키(대칭키)**를 만든다.
6. **Secure Channel (대칭키 암호화 사용):** 이제부터 주고받는 모든 HTTP 데이터는 위에서 만든 **세션키**로 암호화되어 전송된다.

이처럼 Nginx에서 암호화 연결을 끝내고, 내부 서버로는 평문을 보내는 방식을 SSL Termination이라고 한다. 이 덕분에 Spring Boot는 암호화 복호화 연산 부하에서 해방되어 비즈니스 로직에만 집중할 수 있다.

### 왜 두 가지 암호화 방식을 섞어 쓰는가?

- **비대칭키(공개키/개인키):** 보안성은 높지만 계산 과정이 복잡하고 느리다. 따라서 **초기 연결(핸드셰이크) 시 비밀번호를 안전하게 공유하는 용도**로만 짧게 사용한다.
- **대칭키:** 암호화/복호화 속도가 매우 빠르다. 따라서 **실제 대용량 데이터를 주고받을 때** 사용한다.

### 인증 단계 이후의 Let’s Encrypt의 역할

Let’ Encrypt(인증 기관, CA)는 인증서 발급소이지 검문소가 아니다.

- 언제 쓰이는가?
    - 인증서를 처음 발급받을 때 (Certbot 실행 시)
    - 인증서를 갱신할 때 (90일마다)
- 언제 안 쓰이는가?
    - 브라우저가 서버에 접속해서 핸드셰이크를 할 때
    - 데이터를 암호화해서 주고받을 때

인증서의 유효성 검증은 Let’s Encrypt 서버에 물어보는 것이 아니라, 클라이언트(브라우저)가 혼자서 수행한다. (Let’s Encrypt와 통신 x)

Nginx는 핸드셰이크로 합의한 세션키를 이용해 **데이터를 복호화하고, TLS 레코드 무결성 검증을 수행**한다.

- Nginx는 복호화된 평문 데이터를 `proxy_pass` 설정에 따라 로컬(localhost:8080)로 보낸다.

## 8. 왜 HTTPS로 접근하는데 80번 포트가 열려 있어야 하는가?

우리 서버로 들어오는 통신을 HTTPS(443)만 쓸 건데 왜 보안 안 좋은 HTTP(80)를 열어야 할까?

### 이유 1: ACME 프로토콜 표준 (HTTP-01 Challenge)

Let’s Encrypt가 사용하는 자동화 표준인 ACME 프로토콜의 HTTP-01 챌린지 방식은 무조건 포트 80을 통한 연결을 시도하도록 규정되어 있다

- **규칙:** 인증 기관은 `http://<YOUR_DOMAIN>/.well-known/acme-challenge/<TOKEN>` 주소로 요청을 보낸다.
- **제약:** 이 초기 요청은 **반드시 `http://` (Port 80)**여야 한다. 처음부터 `https://`로 요청하지 않는다. 인증서가 없어서 HTTPS 통신 자체가 불가능한 상황을 가정하기 때문이다.

### 이유 2: 네트워크 접근성

AWS 보안 그룹이 80번을 닫아놓으면 Nginx는 요청을 보지도 못 한다.

- 설명: 이것은 패킷 도달 여부의 문제이다. Nginx 설정 파일에 80으로 오면 443으로 리다이렉트 로직을 짜놔도 소용없다. AWS 보안 그룹(방화벽)은 Nginx보다 앞단에 있다. 여기서 80 포트가 닫혀 있으면 요청 패킷은 Nginx에 닿기도 전에 drop된다.

### **이유 3 (사용자 편의성):**

- 사용자는 브라우저 주소창에 `https://`를 매번 치지 않는다. 그냥 `52.79...` 또는 도메인만 입력하면 브라우저는 기본적으로 80포트(HTTP)로 접속을 시도한다. 
- 이때 Nginx가 80으로 들어온 요청을 443(HTTPS)으로 리다이렉트(301 Redirect) 해주지 않으면, 사용자는 접속 불가 화면을 보게 된다. 즉, **Certbot 검증뿐만 아니라 일반 사용자의 자연스러운 접속 흐름을 위해서도 80 포트는 열려 있어야 한다.**
