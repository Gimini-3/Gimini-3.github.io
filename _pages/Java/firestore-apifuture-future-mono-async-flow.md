---
title: "[Firebase/Java] Firestore ApiFuture와 Java Future, 그리고 Reactor Mono까지 – 비동기 흐름 뜯어보기"
date: 2025-10-25 11:13:00 +0900
tags:
  - java
  - firestore
  - apifuture
  - future
  - listenablefuture
  - reactor
  - mono
  - async
  - concurrency
thumbnail: "/assets/img/thumbnail/firestore-apifuture-future-mono-async-flow.png"
---
# Firestore ApiFuture와 Java Future, 그리고 Reactor Mono까지 – 비동기 흐름 뜯어보기

공모전에서 Firestore를 사용하면서 `ApiFuture`를 자연스럽게 쓰고 있었다.

그런데 어느 날 Java의 `Future`와 스레드 풀을 공부하다 보니,

“Firestore가 반환하는 `ApiFuture`는 도대체 어떤 스레드에서 어떻게 동작하는 걸까?”라는 궁금증이 생겼다.

이 글에서는

- `ApiFuture`가 Java `Future`/`ListenableFuture`와 어떻게 연결되는지
- Firestore SDK가 어떤 스레드에서 네트워크 I/O를 처리하는지
- 이 비동기 결과를 Reactor `Mono`로 감싸면서 어떤 설계 결정을 했는지

를 실제 공모전 프로젝트의 코드를 기준으로 하나씩 뜯어보겠다.

---

# ApiFuture<V>

Firestore에서 ApiFuture<V>는  비동기 작업의 결과를 나타내는 Google의 인터페이스이다.

데이터베이스 읽기/쓰기 같은 Firestore 작업은 네트워크를 통해 이루어지므로 시간이 걸린다.

Firestore의 docRef.set(room)는 내부적으로 백그라운드 스레드에서 네트워크 I/O를 수행하고,

그 결과를 나중에 받을 수 있도록 ApiFuture를 반환한다.

ApiFuture 자체는 비동기 작업의 핸들일 뿐이고, get()을 호출하면 여전히 현재 스레드는 블로킹된다.

대신 addListener / ApiFutures.addCallback을 사용하면 블로킹 없이 콜백 방식으로 결과를 처리할 수 있다.

## Future<V>와의 관계

**`ApiFuture<V>`는 Java의 표준 `Future<V>` 인터페이스를 상속한다.**

즉, `ApiFuture<V>`는 `Future<V>`의 모든 기능을 가지면서 추가적인 편의 기능을 제공한다.

```markdown
java.util.concurrent.Future<V>
▲
│ (extends)
com.google.common.util.concurrent.ListenableFuture<V>
▲
│ (extends)
com.google.api.core.ApiFuture<V>
```

### 1. `Future<V>` (Java 표준)

```java
public interface Future<V> {

    boolean cancel(boolean mayInterruptIfRunning);

    boolean isCancelled();

    boolean isDone();

    V get() throws InterruptedException, ExecutionException;

    V get(long timeout, TimeUnit unit)
        throws InterruptedException, ExecutionException, TimeoutException;
}

```

- 비동기 작업의 결과를 나타내는 표준 인터페이스이다.
- 주요 메서드는 `get()`이다.
    - `get()` 메서드는 결과가 준비될 때까지 현재 스레드를 블로킹 시킨다.
    - 작업이 끝날 때까지 프로그램이 그 자리에서 멈춰 기다려야 해서 효율이 떨어질 수 있다.

## 2. `ApiFuture<V>` (Google의 확장)

```java
public interface ApiFuture<V> extends Future<V> {
  void addListener(Runnable listener, Executor executor);
}

```

- `Future<V>`를 상속하므로, `get()` 메서드도 가지고 있다.
- **핵심 기능 (차이점):** `addListener(Runnable listener, Executor executor)` 메서드를 제공한다.
- 이 `addListener`를 사용하면, 스레드를 차단하고 결과를 기다리는 대신 **"작업이 끝나면 이 코드를 실행해줘"**라는 **콜백(callback)**을 등록할 수 있다.
- 작업이 완료되면(성공하든 실패하든), `ApiFuture`가 지정된 `Executor`(스레드)를 사용해 `listener`(콜백 코드)를 자동으로 실행시켜 준다.

# 실제 사용 코드

```java
    //채팅방 생성
    public ConversationRoom createRoom(String userId) {

        // 네트워크 통신을 하지 않는다 (DB에 요청x)
        //Firestore 클라이언트 라이브러리(SDK)가 자체적으로 고유한 20자리 랜덤 ID를 생성한다.
        // 이 ID를 가진 빈 껍데기 주소, 즉 DocumentReference 객체를 만든다.
        DocumentReference docRef = db.collection("ROOMS").document();

        ConversationRoom room = new ConversationRoom();
        room.setTitle("새로운 대화");
        room.setUserId(userId);
        
        //@ServerTimestamp를 통해서 Firestore가 문서를 쓸 때 자동으로 현재 서버 시간을 해당 필드에 기록
        room.setLastMessageAt(null);
        room.setId(docRef.getId()); //확보된 ID를 객체에 설정

        try {
            // Firestore에 데이터를 쓰는 것은 네트워크를 통해 다른 서버에 요청하는 것
            // ApiFuture은 비동기적으로 작업 요청을 한 후 나중에 완료되면 결과를 담음
            // 실제 DB쓰기는 백그라운드 스레드에서 시작
            ApiFuture<WriteResult> future = docRef.set(room);

            // 쓰기가 완료될 때까지 여기서 대기(Blocking)
            future.get(); //이 시점에 InterruptedException 또는 ExecutionException

            // DB쓰기 성공이 확정된 후에 객체를 반환
            return room;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); // 인터럽트 복원
            throw new RuntimeException("채팅방 생성 실패(인터럽트)", e);
        } catch (ExecutionException e) {
            // .get() 실행 중 Firestore 쓰기 실패 (권한, 네트워크 등)
            throw new RuntimeException("채팅방 생성 실패", e);
        }

    }

```

## 1. `ApiFuture`와 비동기 작업의 시작

```java
ApiFuture<WriteResult> future = docRef.set(room);
```

1. **메인 스레드 (A):**
   여기서 “메인 스레드”는 단일 프로그램의 UI 스레드가 아니라, 단순히 `createRoom` 메서드를 실행하고 있는 **요청 처리 스레드**를 의미한다.
    - `docRef.set(room)` 메서드를 **호출**
    - Firestore SDK는 이 요청(room 객체 저장)을 즉시 내부 작업 큐에 등록한다.
    - 그리고 실제 네트워크 작업을 수행할 **다른 스레드**에게 위임한다.
    - 위임 직후, `ApiFuture`라는 **Promise** 객체를 *즉시* 반환한다.
    - **이 시점에서 '메인 스레드'는 멈추지 않고** 바로 다음 줄(`future.get()`)로 이동한다.
2. **Firestore I/O 스레드 (B):**

   > Firestore SDK는 gRPC 클라이언트/Executor를 내부적으로 가지고 있고,
   애플리케이션 스레드(A)에서 넘긴 작업을 이 Executor(스레드 풀)에서 처리한다.
   그래서 애플리케이션 입장에서는 ApiFuture만 받고,
   실제 네트워크 I/O는 SDK의 별도 스레드에서 수행된다.
   >
    - (A) 스레드로터 위임받은 'room 객체 저장' 작업을 실제로 수행한다.
    - 데이터를 직렬화하고, 네트워크를 통해 Firestore 서버와 통신을 시작한다.
    - 이 작업은 (A) 스레드의 작업과 **동시에(비동기)** 일어난다.

---

## 2. `future.get()` - 스레드의 강제 대기 (Blocking)

```java
future.get(); //이 시점에 InterruptedException 또는 ExecutionException
```

- **메인 스레드 (A):** `future.get()`을 만나는 순간, **실행을 멈추고 '대기(Waiting/Blocked)' 상태가 된다.**
- (A) 스레드는 `future`가 '완료' 상태가 될 때까지 아무것도 하지 않고 기다린다.
- **Firestore I/O 스레드 (B):** 한편, (B) 스레드는 여전히 네트워크 통신을 하고 있다.
    - **성공 시:** (B) 스레드가 서버로부터 "저장 성공!" 응답을 받으면, `future` 객체에 `WriteResult`를 넣어주고 '완료' 상태로 만든다.
    - **실패 시:** (B) 스레드가 서버로부터 에러(예: 권한 없음)를 받으면, `future` 객체에 `Exception` 정보를 넣어주고 '완료(실패)' 상태로 만든다.
- `future`의 상태가 '완료'가 되는 순간, 대기 중이던 **메인 스레드 (A)**가 깨어난다(Unblocked).

이 `get()` 호출 때문에, 비동기 작업이 끝날 때까지 동기 방식처럼 기다리게 된다.

---

## 3. 예외 처리와 스레드

### 1) `ExecutionException` (작업 자체의 실패)

- **발생 주체:** **Firestore I/O 스레드 (B)**
- **상황:** (B) 스레드가 Firestore 서버와 통신하다가 실패했다. (네트워크 오류, 서버 다운, 쓰기 권한 없음 등)
- **동작:** (B) 스레드가 이 실패 정보를 `future` 객체에 등록한다.
- **결과:** 대기 중이던 **메인 스레드 (A)**가 깨어나고, `future.get()`은 `ExecutionException`을 **(A) 스레드에게 던진다.**
- `e.getCause()`를 호출하면 (B) 스레드가 겪었던 실제 원인(예: `FirestoreException`)을 알 수 있다.

### 2) `InterruptedException` (작업 대기 중 방해)

- **발생 주체:** **제 3의 스레드 (C)** (메인 스레드도, I/O 스레드도 아닌)
- **상황:** **메인 스레드 (A)**가 `future.get()`에서 대기하고 있다. 이때 (C) 스레드가 (A) 스레드를 깨우기 위해 `(A스레드).interrupt()` 신호를 보낸다. (예: 웹 서버가 종료될 때 요청 처리 스레드를 강제 종료시킬 경우)
- **동작:** (A) 스레드는 작업을 기다리던 것을 *중단*하고 즉시 깨어난다.
- **결과:** `future.get()`은 `InterruptedException`을 **(A) 스레드에게 던진다.**
- **중요 포인트 1:** 이건 **Firestore 작업 실패와 무관**할 수 있다. 단지 **A의 ‘대기’가 끊겼다**는 뜻이다. 백그라운드 작업(B)은 **여전히 돌고 있을 수 있다.**
- **중요 포인트 2:** `InterruptedException`이 던져지는 시점에 **현재 스레드의 interrupt flag는 클리어**되기 때문에, 관례상 `catch` 안에서 `Thread.currentThread().interrupt()`로 다시 설정한 뒤 상위로 전달하거나 적절히 중단 처리해야 한다.

---

# `ApiFutures`

- 유틸리티 클래스
- 이 클래스 안에는 ApiFuture 객체를 더 쉽게 다룰 수 있게 도와주는 static 메서드들이 들어 있다.
- 핵심 기능: `ApiFutures.addCallback(future, callback, executor)`
    - ApiFuture 객체를 받아서 “이 작업이 성공하면 이 코드를 실행하고, 실패하면 저 코드를 실행해 줘”라는 콜백을 등록할 수 있다.

## `ApiFutures.addCallback(future, callback, executor)`

```java
  public static <V> void addCallback(
      final ApiFuture<V> future, final ApiFutureCallback<? super V> callback, Executor executor) {
    Futures.addCallback(
        listenableFutureForApiFuture(future),
        new FutureCallback<V>() {
          @Override
          public void onFailure(Throwable t) {
            callback.onFailure(t);
          }

          @Override
          public void onSuccess(V v) {
            callback.onSuccess(v);
          }
        },
        executor);
  }
```

### **1. `listenableFutureForApiFuture(future)`**

> `ApiFuture`는 이미 `ListenableFuture`를 상속하고 있기 때문에,
`listenableFutureForApiFuture`는 대부분의 경우 캐스팅 또는 어댑터 역할을 한다.
결국 Guava `Futures.addCallback`을 쓰기 위해 `ApiFuture`를 `ListenableFuture`로 브릿지해준다
>

### **2. `new FutureCallback<V>() { ... }`**

- `ApiFutures.addCallback`이 요구하는 콜백 타입은 `FutureCallback` 인터페이스이다.
- 근데 우리가 파라미터로 받은 건 `ApiFutureCallback` 인터페이스이다.
- 그래서 `FutureCallback` 익명 클래스를 즉석에서 만들어서, 그 내부에서 우리가 받은 `ApiFutureCallback`(변수명 `callback`)을 **그대로 호출**해주는 것이다.
- `onFailure`가 오면 `callback.onFailure`를, `onSuccess`가 오면 `callback.onSuccess`를 부르는 **전달자** 역할을 한다.

### 3. `Executor executor`

`Executor`는 콜백(onSuccess/onFailure)을 어떤 스레드에서 실행할지를 결정하는 규칙이다.

1. `MoreExecutors.directExecutor()`
- 동작: 즉시 실행
- 별도의 스레드를 사용하지 않는다. `ApiFuture`의 비동기 작업(예: Firestore I/O)을 완료시킨 바로 그 스레드가, 콜백을 즉시 직접 실행한다.
- 언제 쓰는가?
    - 스레드를 갈아타는 비용이 없어서 성능이 가장 좋다.
    - 콜백 로직이 아주 가볍고, 절대 블로킹 되지 않을 때 쓴다.
1. 스레드 풀 (예: **`Executors.newFixedThreadPool(nThreads)`, `Executors.newCachedThreadPool()` )**
- 동작: 작업 위임
- `ApiFuture` 가 완료되면, 콜백 로직(Runnable)을 이 스레드 풀에 작업으로 제출(submit)한다.

  그럼 풀에 대기 중인 워커 스레드 중 하나가 그 콜백을 실행한다.

- 언제 쓰는가?
    - 콜백안에서 시간이 걸리는 작업을 해야 할 때 쓴다.
    - 예를 들어, DB에서 읽은 결과로 다시 파일을 쓰거나, 다른 네트워크 요청을 보내는 등 **무겁거나 블로킹되는 작업**을 할 때 쓴다.
    - 이렇게 하면, `ApiFuture`를 완료시켰던 I/O 스레드는 무거운 콜백 처리를 워커 스레드에게 넘기고, 자기는 즉시 다른 I/O 작업을 하러 갈 수 있어서 효율적이다.

---

## 실제 사용 코드

```java
/**
 * Firestore에 질문/답변 한 쌍을 하나의 메시지로 저장하고,
 * 저장된 결과를 다시 읽어와 ConversationMessage로 반환하는 메서드.
 *
 * 핵심 포인트:
 * - Firestore의 ApiFuture를 Reactor의 Mono로 감싸서 리액티브하게 사용
 * - set(쓰기) → get(읽기)를 체이닝
 * - timeout, retry, onErrorResume로 실패 시 복구 전략 정의
 */
public Mono<ConversationMessage> createMessage(String question, String answer, String roomId) {

    // 1. Firestore 컬렉션/문서 경로 구성
    //    - ROOM 컬렉션 아래에 각 방(roomId) 문서가 있고,
    //    - 그 아래 MESSAGES 서브컬렉션에 메시지 문서가 쌓인다고 가정.
    DocumentReference ref = db
            .collection(ROOMS)
            .document(String.valueOf(roomId))
            .collection(MESSAGES)
            .document(); // 여기서 Firestore가 새 문서 ID를 랜덤으로 생성해 줌

    // 2. 우선 애플리케이션 레벨에서 사용할 메시지 객체 하나를 만들어 둔다.
    //    - Firestore에서 toObject() 실패/타임아웃이 나도 이 객체를 fallback으로 쓸 수 있게 하기 위함.
    String messageId = ref.getId();
    ConversationMessage message = ConversationMessage.builder()
            .question(question)
            .answer(answer)
            .id(messageId)   // Firestore에서 생성한 문서 ID를 그대로 사용
            .roomId(roomId)
            .build();

    // 3. Firestore에 message를 쓰는 비동기 작업을 Mono로 감싸기
    //    - ref.set(message)는 ApiFuture<WriteResult>를 반환한다.
    //    - ApiFutures.addCallback으로 완료 콜백을 등록하고,
    //      그 콜백 안에서 Reactor의 sink.success / sink.error를 호출해 Mono를 완료시킨다.
    Mono<WriteResult> setMono = Mono.create(sink -> {
        ApiFutures.addCallback(
                ref.set(message),                          // 비동기 쓰기 작업 시작
                new ApiFutureCallback<WriteResult>() {     // 작업 완료 시 호출될 콜백

                    @Override
                    public void onFailure(Throwable t) {
                        // Firestore 쓰기 실패 → Mono 에러로 전달
                        sink.error(t);
                    }

                    @Override
                    public void onSuccess(WriteResult wr) {
                        // Firestore 쓰기 성공 → Mono 정상 완료
                        sink.success(wr);
                    }

                },
                // 콜백을 별도 스레드 풀로 보내지 않고,
                // Firestore I/O 스레드에서 바로 실행하도록 하는 Executor.
                // 콜백 내부가 가볍기 때문에 directExecutor로 스레드 전환 비용을 줄인다.
                MoreExecutors.directExecutor()
        );
    });

    // 4. 방금 쓴 문서를 다시 읽어오는 비동기 작업을 Mono로 감싸기
    //    - ref.get() 역시 ApiFuture<DocumentSnapshot>를 반환.
    //    - 패턴은 setMono와 동일하게 ApiFutures.addCallback + Mono.create 사용.
    Mono<DocumentSnapshot> getMono = Mono.create(sink -> {
        ApiFutures.addCallback(
                ref.get(),                                     // 비동기 읽기 작업 시작
                new ApiFutureCallback<DocumentSnapshot>() {    // 완료 콜백

                    @Override
                    public void onFailure(Throwable t) {
                        // 읽기 실패 → Mono 에러
                        sink.error(t);
                    }

                    @Override
                    public void onSuccess(DocumentSnapshot snap) {
                        // 읽기 성공 → DocumentSnapshot 전달
                        sink.success(snap);
                    }

                },
                MoreExecutors.directExecutor()
        );
    });

    // 5. 리액티브 파이프라인 구성
    return setMono                  // (1) 먼저 쓰기 작업을 수행하고
            .then(getMono)          // (2) 쓰기가 끝나면 이어서 읽기 작업 실행
            .map(snap -> {          // (3) 읽어온 DocumentSnapshot을 도메인 객체로 변환

                // 문서가 존재하지 않으면(이상 상황) fallback으로 처음 만든 message 반환
                if (!snap.exists()) return message;

                // Firestore가 저장한 JSON → ConversationMessage로 역직렬화
                ConversationMessage cm = snap.toObject(ConversationMessage.class);

                // 역직렬화에 실패하면 역시 fallback 객체 사용
                if (cm == null) return message;

                // Firestore에서 읽어온 엔티티에 ID/roomId를 다시 한 번 확실히 세팅
                cm.setId(snap.getId());
                cm.setRoomId(roomId);

                return cm;
            })
            // (4) 전체 파이프라인에 5초 타임아웃 적용
            //     5초 안에 쓰기+읽기가 끝나지 않으면 TimeoutException 발생
            .timeout(java.time.Duration.ofSeconds(5))
            // (5) 그래도 실패하면(모든 재시도/타임아웃/기타 에러) 최종 fallback 전략:
            //     - 에러를 호출자에게 그대로 전달하지 않고,
            //     - 처음에 만들어 두었던 message 객체를 그대로 반환한다.
            //     → UI 입장에서는 "일단 메시지는 생성된 것처럼" 동작하게 된다.
            .onErrorResume(e -> Mono.just(message));
            //이 경우 실제 Firestore에 저장이 안 되었을 수도 있으므로, 
            //운영 환경에서는 별도의 로그/알람으로 실패 케이스를 추적하고, 
            //필요하다면 재처리 배치를 두는 등 데이터 정합성을 보완해줄 필요가 있다.
}

```

---

## 마무리 요약

- Firestore Java SDK의 `ApiFuture<V>`는 `Future<V>` → `ListenableFuture<V>`를 확장한 형태로, **비동기 작업의 결과를 표현하는 핸들**이다.
- `get()`을 호출하면 여전히 호출한 스레드는 **블로킹**되지만, `addListener`나 `ApiFutures.addCallback`을 사용하면 **콜백 기반으로 결과를 처리**할 수 있어 스레드를 막지 않고 비동기 체인을 만들 수 있다.
- Firestore 연산(`docRef.set`, `docRef.get`)은 내부적으로 **별도 I/O 스레드 풀에서 네트워크 작업을 수행**하고, 그 완료 여부와 결과를 `ApiFuture` 객체에 기록한다.
- `ExecutionException`은 비동기 작업에서 발생한 예외를 `future.get()`을 호출한 스레드로 전달하기 위한 **래퍼 예외**이고, 실제 원인은 `getCause()`로 확인할 수 있다.
- `InterruptedException`은 결과를 기다리던 스레드가 외부에서 인터럽트됐다는 신호이며, 관례적으로 `catch` 블록에서 `Thread.currentThread().interrupt()`를 호출해 **인터럽트 상태를 복구**해 주어야 한다.
- `ApiFuture`를 Reactor의 `Mono`로 감싸면, `timeout`, `retry`, `onErrorResume` 등을 조합해 **재시도/타임아웃/폴백 전략**을 코드 상에서 명시적으로 설계할 수 있다. 이때 재시도에 따른 중복 쓰기, 폴백 시 데이터 정합성 등은 의도적으로 선택한 트레이드오프임을 인지하고 설계해야 한다.