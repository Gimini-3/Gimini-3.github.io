---
layout: post
title: ""
date: 2025-11-30 20:30:00 +0900
categories: OAuth2, Spring Security, Kakao Login
---


# 카카오 로그인 동작과정 분석하기(sdk 방식)

### [전제 조건 및 설계 원칙]

- **환경 전제**
    - 웹 브라우저 기준으로 설명한다.
    - 모바일 앱이라면 `authorize()` 호출 시 **카카오톡 앱이 먼저 실행**되고,
        
        그 안의 WebView에서 `kauth.kakao.com` 페이지를 띄워 로그인/동의가 진행된다.
        
- **로그인 시작 방식**
    - 로그인 버튼 클릭 시, 프론트에서 **백엔드를 거치지 않고** 바로
        
        `Kakao.Auth.authorize()` 를 호출한다.
        
    - 이 호출은 브라우저를 **`https://kauth.kakao.com/oauth/authorize` 로 이동**시킨다.
        
        → 프론트 → (백엔드 패스) → Kakao Auth Server
        
- **인가 코드 수신 주체**
    - `redirect_uri` 를 **프론트 주소**로 설정한다.
    - 동의 완료 후, Kakao Auth Server는
        
        `302 Location: {redirect_uri}?code=...` 로 응답한다.
        
    - 브라우저가 이 `redirect_uri`(프론트 URL)로 이동하면서 **인가 코드는 먼저 프론트가 받는다.**
    - 프론트는 URL에서 `code`를 추출해 **백엔드 로그인 API로 전달**하여 토큰 발급·회원 처리 등을 진행한다.

# 전체 아키텍처

<img width="1207" height="914" alt="image" src="https://github.com/user-attachments/assets/ca4cec7f-5487-4636-9b6a-0d561a87a15e" />


# 1. 사용자가 로그인 버튼 클릭: 프론트 → Kakao Auth 서버

사용자가 우리 사이트에서 “카카오로 로그인” 버튼을 누른다.

JS SDK 방식에서는 이 버튼 클릭이 결국 카카오 JS SDK의 `authorize` 호출로 이어지고,

이 함수는 브라우저의 주소를 카카오 Auth 서버의 인가 엔드포인트로 바꾸어 버린다.

```bash
Kakao.Auth.authorize({
	redirectUri: 'http://localhost:5173/oauth/kakao/callback'
});
```

결국 이 호출은 다음과 같이 나가게 된다.

```bash
https://kauth.kakao.com/oauth/authorize?
	client_id=
	&redirect_uri=http://localhost:5173/oauth/kakao/callback
	&response_type=code 
```

여기서 중요한 점은:

- 이 시점에는 **우리 백엔드를 전혀 거치지 않는다**는 것.
- 브라우저는 곧바로 kauth.kakao.com으로 이동해서 카카오 Auth 서버와 통신한다는 것.

로그인 시작부터 브라우저 ↔ 카카오 Auth 서버가 직접 붙는 구조다.

# 1-1. 로그인 안 되어 있을 때 : Auth → Account → Auth 왕복

<img width="1160" height="744" alt="image" src="https://github.com/user-attachments/assets/d198ba61-759c-4f15-965b-962ebe4851b1" />

카카오 Auth 서버 입장에서, 브라우저가 보낸 인가 코드 요청을 받았다.

1. Auth 서버는 이 브라우저에 **카카오 계정 로그인 세션이 있는지** 확인한다.
2. 로그인 세션이 없다면, “먼저 카카오 계정 로그인을 시켜야 한다”고 판단한다.
3. 그래서 Auth 서버는 브라우저에게 “카카오 Account 서버로 가라”는 의미의 302 리다이렉트 응답을 보낸다.
    
    이때 응답의 Location 헤더에는 Account 서버의 로그인 URL과 함께 `continue`라는 파라미터가 붙어 있다.
    
- `continue` 파라미터

> 로그인까지 끝난 뒤 다시 돌아와야 할 Auth 서버의 /oauth/authorize 요청 전체를 그대로 기억해 두는 것
> 

```bash
https://accounts.kakao.com/login?
continue=https%3A%2F%2Fkauth.kakao.com%2Foauth%2Fauthorize%3Fclient_id%3Dd2ffdfaa297012904086e71f5d7eda1f%26redirect_uri%3Dhttp%253A%252F%252Flocalhost%253A3000%252Foauth%252Fkakao%252Fcallback%26response_type%3Dcode%26through_account%3Dtrue%26auth_tran_id%3DwbrMy9IcVMYhPjgkbCpf7-TiGF7balKdB--tpTWfCg0VmwAAAZrDiMg9#login
```

`continue=` 뒤에 있는 건 전부 URL 인코딩된 문자열이다.

- URL 디코더를 통해서 위의 인코딩된 문자열 디코딩 결과
    
    ```bash
    https://accounts.kakao.com/login?
    continue=https://kauth.kakao.com/oauth/authorize?
    client_id={client_id}&
    redirect_uri=http://localhost:5173/oauth/kakao/callback&
    response_type=code&
    through_account=true&
    auth_tran_id=wbrMy9IcVMYhPjgkbCpf7-TiGF7balKdB--tpTWfCg0VmwAAAZrDiMg9#login
    ```
    
    - continue=
    
    → 우리가 원래 쳤던 인가 코드 받는 엔드포인트
    
    - client_id=…
    
    →  JS SDK 플로우에서는 JavaScript 키가 client_id로 사용된다.
    
    - redirect_uri
    
    → 동의 후 인가 코드를 보내줄 프론트 주소(백으로 설정하면 백주소)
    
    - response_type = code
    
    → OAuth2에서 인가 코드 플로우를 쓰겠다는 뜻
    
    - through_account = true
    
    → 계정 로그인 서버를 통해서 처리하는 중이다 정도의 카카오 내부 플래그
    
    - auth_tran_id=
    
    → 카카오가 이 인증 트랜잭션을 추적하기 위한 내부 트랜잭션 ID
    

브라우저는 Auth 서버가 보내준 Location 값을 그대로 따라가서 Account 서버의 로그인 페이지를 연다.

<img width="880" height="1018" alt="image 1" src="https://github.com/user-attachments/assets/f6e94d68-2c9e-4ac7-ac65-f7a3433acb15" />


이제 사용자는 이 페이지에서 카카오 계정 이메일과 비밀번호를 입력하고 로그인 버튼을 누른다.

로그인이 성공하면 Account 서버는 `continue`에 들어 있던 인가 요청 URL을 꺼내서,

다시 그 URL로 302 리다이렉트를 보낸다.

브라우저는 또 한 번 302 Location을 따라가서 다시 Auth 서버의 `/oauth/authorize` 로 돌아간다.

 

### 로그인 버튼 누른 뒤에 일어나는 일

1. 사용자는 여기서 아이디 비밀번호를 누르고 로그인 버튼을 누른다.
2. 로그인 버튼을 누르면 이 폼을 Account 서버로 제출한다.
    
    → 예: POST [https://accounts.kakao.com/login](https://accounts.kakao.com/login) 같은 요청
    
3. Account 서버가 ID/비번 검증해서 로그인 성공 처리하고 내부에서 continue 파라미터에 있던 값을 꺼내서 응답으로 돌려준다.
    
    ```bash
    HTTP/1.1 302 Found
    Location: https://kauth.kakao.com/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&...
    ```
    
4. 브라우저는 이 Location 헤더를 보고 
    
    → 자동으로 
     `GET https://kauth.kakao.com/oauth/authorize?...` 요청을 다시 보냄
    
    ```bash
    https://kauth.kakao.com/oauth/authorize?
    client_id={client_id}&
    redirect_uri=http://localhost:5173/oauth/kakao/callback&
    response_type=code
    ```
    

브라우저가 302 응답을 받자마자 순식간에 다음 주소로 이동하기 때문에 육안으로는 볼 수 없다.

- 확인 방법
    1. F12를 눌러 개발자 도구를 연다.
    2. 상단 탭 중 Network 탭을 클릭한다.
    3. Network 탭 상단 메뉴바에 있는 **`Preserve log` (로그 보존)** 체크박스를 **반드시** 체크한다.
        - 이걸 체크하지 않으면, 페이지가 `accounts`에서 `kauth`로 이동(리다이렉트)하는 순간 이전 기록이 전부 지워져서 302 응답을 볼 수 없다.
    4. 이제 브라우저에서 로그인 버튼을 눌러 로그인을 시도한다.
    5. Network 탭의 리스트 중에서 **`login`** 혹은 **`authorize`** 라는 이름의 요청을 찾는다.
    6. Status(상태) 코드가 **`302`** 인 항목을 클릭한다.
    7. 오른쪽 상세 창의 **Response Headers(응답 헤더)** 탭을 보면 **`Location`** 항목에 네가 찾던 그 URL(`https://kauth.kakao.com/...`)이 적혀 있는 것을 확인할 수 있다.

# 2. 동의 화면: Auth 서버가 HTML을 내려주고, 브라우저가 렌더링한다.

현재 상태

- 브라우저는 카카오 계정에 로그인된 상태다.
- Auth 서버는 인가 코드 요청을 정상적으로 받을 수 있는 상태다.

Auth 서버는 이 요청에 대해 다음과 같이 행동한다.

- 사용자가 이 앱(우리 서비스)에 **처음 접근**했다면
    
    → 어떤 정보(프로필, 이메일 등)를 제공할지 보여주는 **동의 화면**을 내려준다.
    
- 이미 예전에 한 번 동의한 앱이라면
    
    → 동의 화면을 생략하고 바로 인가 코드 발급으로 넘어갈 수 있다.
    

여기서 중요한 점:

- 동의 화면은 **항상 웹 페이지**다.
- 서버는 Auth 서버(kauth)에서 HTML을 내려주고,
- **클라이언트가 브라우저라면 브라우저가,
카카오톡 앱이라면 카카오톡 앱 안의 WebView가 그 HTML을 렌더링**할 뿐이다.

웹 기준에서는 그냥 **브라우저에서 카카오 동의 화면 페이지를 보는 것**이라고 이해하면 된다.

---

# 3. 동의하고 계속하기

사용자가 동의 화면에서 **“동의하고 계속하기”** 버튼을 누른다.

- 브라우저는 이 버튼을 누르면서 Auth 서버로 폼 제출/JS 요청을 보내고,
- Auth 서버는 내부적으로 인가 코드(`code`)를 하나 발급한 뒤,
- 아래와 같이 응답한다.

```
HTTP/1.1 302 Found
Location: {redirect_uri}?code=AUTH_CODE&state=STATE_VALUE

```

중요한 점:

1. **`redirect_uri`는 우리가 처음 `/oauth/authorize` 요청에 넘겨줬던 값**이다.
2. Auth 서버는 이 값을 그대로 끌고 와서 뒤에 `?code=...&state=...` 를 붙인 뒤
    
    **Location 헤더에 넣는다**.
    
3. 브라우저는 “redirect_uri”라는 개념을 모른다.
    - 302의 Location에 해당하는 URL로 이동할 뿐이다.

---

# 4. redirect_uri가 프론트 일 때

우리는 전제로 `redirect_uri`를 프론트 주소로 놓았다.

```
redirect_uri = http://localhost:5173/oauth/kakao/callback
```

그럼 Auth 서버의 응답은 대략 이렇게 된다.

```
HTTP/1.1 302 Found
Location: http://localhost:5173/oauth/kakao/callback?code=AUTH_CODE&state=...
```

브라우저는 이걸 보고:

```
GET http://localhost:5173/oauth/kakao/callback?code=AUTH_CODE&state=...
```

를 다시 호출한다.

이 시점에 일어나는 일:

- **이 URL에 매핑된 프론트 라우트(React/Vite)** 가 로드된다.

이렇게 하면 인가 코드는 백엔드가 직접 받는 것이 아니라, 브라우저(프론트)가 URL로 전달받고 → 백엔드로 다시 넘기는 구조가 된다.

---

# 5. 백엔드: 인가 코드 → 액세스 토큰 교환

<img width="631" height="164" alt="image" src="https://github.com/user-attachments/assets/fd6f5121-c6fa-4d5b-8ed6-9ed807e73cb6" />


프론트에서 `/api/auth/kakao/login` 으로 `code`를 넘기면,

이제부터는 **백엔드(Spring)** 의 역할이다.

1. 카카오 Auth 서버의 `/oauth/token` 엔드포인트를 호출한다.
    
    ```
    POST https://kauth.kakao.com/oauth/token
    Content-Type: application/x-www-form-urlencoded
    
    grant_type=authorization_code
    &client_id=REST_API_KEY
    &redirect_uri=http://localhost:5173/oauth/kakao/callback
    &code=AUTH_CODE
    
    ```
    
    여기서 중요한 점:
    
    - 이때 `client_id`로 사용하는 것은 **REST API 키**다.
    - 프론트(Javascript SDK)에서는 **JavaScript 키**를 사용한다.
    - REST API 키는 **백엔드에서만 사용해야 하는 비공개 키**다.
2. 응답으로 액세스 토큰/리프레시 토큰을 받는다.

```bash
{
"token_type": "bearer",
"access_token": "ACCESS_TOKEN",
"expires_in": 21599,
"refresh_token": "REFRESH_TOKEN",
"refresh_token_expires_in": 5183999,
"scope": "profile_nickname account_email"
}
```

---

# 6. 백엔드: Kakao API Server에서 유저 정보 조회

<img width="656" height="128" alt="image" src="https://github.com/user-attachments/assets/9fbeb5ca-c284-427b-948f-42ea07571fc2" />

이제 백엔드는 받은 `access_token`을 이용해

Kakao API Server (`kapi.kakao.com`) 에서 유저 정보를 조회한다.

```
GET https://kapi.kakao.com/v2/user/me
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/x-www-form-urlencoded;charset=utf-8

```

응답 예시는 대략 이런 형태다.

```json
{
  "id": 1234567890,
  "kakao_account": {
    "profile": {
      "nickname": "홍길동",
      "profile_image_url": "..."
    },
    "email": "example@kakao.com",
    "has_email": true,
    "is_email_valid": true,
    "is_email_verified": true}
}

```

이 정보를 기반으로 우리 도메인에서:

- `SocialAccount` 엔티티 (provider=KAKAO, social_user_id=카카오 id) 생성/조회
- `Member` 엔티티와 1:N 관계로 묶기
- 이메일/전화번호로 기존 회원과 연결 여부 판단
- 신규 가입이면 Member 생성, 기존 회원이면 해당 Member에 소셜 계정 추가

같은 작업을 수행하면 된다.

---

# 7. 우리 서비스 토큰 발급 및 최종응답

<img width="257" height="115" alt="image" src="https://github.com/user-attachments/assets/fb292a87-6315-4a93-9c30-58d45cfca7fe" />

마지막으로, 우리 서비스 자체의 로그인 처리를 한다.

1. `Member` / `SocialAccount` 기준으로 실제 사용자 식별
2. 우리 서비스용 **JWT Access Token / Refresh Token** 발급
3. 프론트로 응답

예:

```json
{
  "accessToken": "OUR_SERVICE_ACCESS_TOKEN",
  "refreshToken": "OUR_SERVICE_REFRESH_TOKEN",
  "member": {
    "id": 100,
    "nickname": "김기민",
    "role": "PARENT"
  }
}

```

이제 사용자는 **“카카오 계정으로 로그인한 우리 서비스 사용자”**가 된다.

---
